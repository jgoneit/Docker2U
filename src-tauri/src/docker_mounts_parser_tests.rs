use super::*;

fn parse(mounts: Value) -> ContainerMounts {
    let id = "a".repeat(64);
    parse_mounts(
        &serde_json::to_vec(&serde_json::json!({"Id":id,"Mounts":mounts})).unwrap(),
        &[id],
    )
    .unwrap()
    .remove(0)
}
#[test]
fn mount_projection_preserves_volume_bind_tmpfs_and_read_only_without_extra_fields() {
    let row = parse(serde_json::json!([
        {"Type":"volume","Name":"shared","Source":"/engine/volumes/shared/_data","Destination":"/var/data","RW":true,"Driver":"secret-driver"},
        {"Type":"bind","Source":"/private/config 한글 ; $(touch forbidden)","Destination":"/app/config","RW":false},
        {"Type":"tmpfs","Source":"","Destination":"/tmp","RW":true}
    ]));
    assert!(row.mounts_available);
    assert_eq!(row.mounts[0].volume_name.as_deref(), Some("shared"));
    assert_eq!(row.mounts[0].read_only, Some(false));
    assert_eq!(row.mounts[1].read_only, Some(true));
    assert_eq!(
        row.mounts[1].source.as_deref(),
        Some("/private/config 한글 ; $(touch forbidden)")
    );
    assert!(row.mounts[2].source.is_none() && row.mounts[2].volume_name.is_none());
    assert!(
        !serde_json::to_string(&row)
            .unwrap()
            .contains("secret-driver")
    );
    for forbidden in [
        "{{json .}}",
        "json .Mounts",
        "Config",
        "HostConfig",
        "Env",
        "Labels",
        "Driver",
    ] {
        assert!(!MOUNTS_FORMAT.contains(forbidden));
    }
}
#[test]
fn missing_invalid_and_oversized_mount_fields_are_unknown_not_shared_none() {
    for value in [
        Value::Null,
        serde_json::json!({}),
        serde_json::json!([null]),
    ] {
        let result = parse(value);
        assert!(!result.mounts_available && result.mounts.is_empty());
    }
    for value in [
        serde_json::json!([{"Type":"bind","Source":"/source","Destination":"/target","RW":"false"}]),
        serde_json::json!([{"Type":"volume","Destination":"/target","RW":true}]),
        serde_json::json!([{"Type":"unknown","Destination":"/target","RW":true}]),
        serde_json::json!([{"Type":"bind","Source":"x".repeat(FIELD_BYTES+1),"Destination":"/target","RW":false}]),
    ] {
        assert!(parse(value).mounts_available);
    }
    let rw = parse(serde_json::json!([{"Type":"bind","Source":"/source","Destination":"/target"}]));
    assert!(rw.mounts[0].read_only.is_none());
    assert!(parse(serde_json::json!([])).mounts_available);
    assert!(
        !parse(serde_json::json!(vec![
            Value::Null;
            MOUNTS_PER_CONTAINER + 1
        ]))
        .mounts_available
    );
}
#[test]
fn wrong_duplicate_missing_and_invalid_mount_ids_reject_the_batch() {
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    let line = serde_json::json!({"Id":a,"Mounts":[]}).to_string();
    assert!(parse_mounts(line.as_bytes(), std::slice::from_ref(&b)).is_err());
    assert!(parse_mounts(format!("{line}\n{line}").as_bytes(), &[a.clone(), b]).is_err());
    assert!(parse_mounts(b"", std::slice::from_ref(&a)).is_err());
    assert!(parse_mounts(b"{\"Id\":\"short-id\",\"Mounts\":[]}", &[a]).is_err());
}
