try {
  const t = localStorage.getItem("1mind-theme");
  if (t) document.documentElement.dataset.theme = t;
} catch {}
