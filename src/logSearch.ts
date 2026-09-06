/** Literal Unicode case-insensitive search. Escaping keeps metacharacters ordinary text. */
export function findLogMatches(text: string, query: string): number[] {
  if (!query) return [];
  const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const positions: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = literal.exec(text)) !== null) positions.push(match.index);
  return positions;
}
