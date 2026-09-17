// 제출 이미지를 브라우저에서 리사이즈+JPEG 압축 → dataURL(base64) 반환.
// 목표: 장당 약 300~500KB (글씨 판독 가능, Firestore 1MiB 문서 한도 이내).

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function fit(w, h, maxDim) {
  if (w <= maxDim && h <= maxDim) return { w, h };
  const r = w > h ? maxDim / w : maxDim / h;
  return { w: Math.round(w * r), h: Math.round(h * r) };
}

// dataURL(base64) 대략 바이트 수
function approxBytes(dataUrl) {
  const i = dataUrl.indexOf(",");
  return Math.floor((dataUrl.length - i - 1) * 0.75);
}

export async function compressImage(file, opts = {}) {
  const { maxDim = 1600, startQuality = 0.72, minQuality = 0.4, targetBytes = 460 * 1024 } = opts;
  const img = await loadImage(file);
  const { w, h } = fit(img.naturalWidth, img.naturalHeight, maxDim);

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);

  let q = startQuality;
  let dataUrl = canvas.toDataURL("image/jpeg", q);
  while (approxBytes(dataUrl) > targetBytes && q > minQuality) {
    q = Math.round((q - 0.08) * 100) / 100;
    dataUrl = canvas.toDataURL("image/jpeg", q);
  }
  return dataUrl; // "data:image/jpeg;base64,...."
}
