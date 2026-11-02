(() => {
  const choices = [...document.querySelectorAll('[data-exercise]')];
  const panes = [...document.querySelectorAll('[data-exercise-pane]')];
  let revision = 0;
  function select(key) {
    revision++;
    choices.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.exercise === key)));
    panes.forEach(pane => { pane.hidden = pane.dataset.exercisePane !== key; });
    document.querySelectorAll('.copy-status').forEach(status => { status.textContent = ''; });
  }
  choices.forEach(button => {
    button.addEventListener('click', () => select(button.dataset.exercise));
    button.disabled = false;
  });
  document.querySelectorAll('[data-copy]').forEach(button => {
    let request = 0;
    button.addEventListener('click', async () => {
      const version = revision, attempt = ++request;
      const field = document.getElementById('prompt-' + button.dataset.copy);
      const status = document.getElementById('status-' + button.dataset.copy);
      try {
        await navigator.clipboard.writeText(field.value);
        if (version === revision && attempt === request) status.textContent = button.dataset.copied;
      } catch {
        if (version !== revision || attempt !== request) return;
        field.focus(); field.select();
        status.textContent = button.dataset.fallback;
      }
    });
    button.disabled = false;
  });
  const advanced = document.querySelector('.advanced-tool');
  const openDeepLink = () => { if (location.hash === '#tools' && advanced) advanced.open = true; };
  window.addEventListener('hashchange', openDeepLink);
  openDeepLink();
})();
