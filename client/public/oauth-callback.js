(() => {
  const result = document.body.dataset.oauthResult === 'success' ? 'success' : 'error';
  const message = document.querySelector('.msg')?.textContent || '';

  if (window.opener && window.opener !== window) {
    window.opener.postMessage(
      { type: `oauth-callback-${result}`, message },
      window.location.origin,
    );
  }

  window.setTimeout(() => window.close(), 2000);
})();
