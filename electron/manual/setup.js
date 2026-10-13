for (const [id, action] of [['dashboard', 'openDashboard'], ['import', 'importConfig']]) {
  document.getElementById(id).addEventListener('click', async () => {
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    document.getElementById('status').textContent = id === 'import' ? 'Opening import…' : 'Opening dashboard…';
    try { document.getElementById('status').textContent = await window.fpsDesktop[action](); }
    catch { document.getElementById('status').textContent = 'Could not complete setup. Your configuration was not replaced.'; }
    finally { document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  });
}
