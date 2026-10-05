const language = new URLSearchParams(window.location.search).get('lang') === 'en' ? 'en' : 'ko';
document.documentElement.lang = language;
document.title = language === 'en'
  ? 'Docker2U — Your containers. One place to work.'
  : 'Docker2U — 컨테이너 작업, 한 화면에서.';
document.querySelector('meta[name="description"]').content = language === 'en'
  ? 'A desktop control panel for Docker on your Mac. Logs, incidents, diagnostics, Compose, and container terminals in one place.'
  : '내 Mac의 Docker를 위한 데스크톱 컨트롤 패널. 프로젝트와 컨테이너의 로그, 사건, 진단, 터미널을 한 화면에서 확인하세요.';
for (const link of document.querySelectorAll('[data-language]')) {
  if (link.dataset.language === language) link.setAttribute('aria-current', 'true');
  else link.removeAttribute('aria-current');
  const destination = new URL(window.location.href);
  destination.searchParams.set('lang', link.dataset.language);
  link.href = destination.href;
}
for (const link of document.querySelectorAll('[data-install-link]')) {
  link.href = 'https://github.com/jgoneit/Docker2U/blob/main/docs/INSTALL.md' + (language === 'en' ? '#english' : '');
}
for (const link of document.querySelectorAll('[data-readme-link]')) {
  link.href = 'https://github.com/jgoneit/Docker2U/blob/main/' + (language === 'en' ? 'README.en.md' : 'README.md');
}
