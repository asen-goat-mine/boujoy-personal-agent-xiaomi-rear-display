// Styling only: the page receives no Node.js or privileged IPC bridge.
window.addEventListener('DOMContentLoaded',()=>{
  document.documentElement.classList.add('desktop-shell',process.platform==='darwin'?'desktop-mac':'desktop-other');
});
