// 제출 이미지를 브라우저에서 리사이즈+JPEG 압축 → dataURL(base64) 반환.
// 목표: 장당 약 300~500KB (글씨 판독 가능, Firestore 1MiB 문서 한도 이내).
//
// 아이폰이 기본으로 찍는 HEIC/HEIF 는 사파리 밖에서는(안드로이드 크롬 등) <canvas> 가
// 못 읽어서 그냥 두면 압축이 실패하고, 그 결과 수십 MB짜리 원본이 그대로 업로드되거나
// 업로드 자체가 실패한다. 그래서 압축 전에 HEIC 이면 먼저 JPEG 로 변환한다.
// (EXIF 방향 보정은 넣지 않았다: 현재 모든 주요 브라우저가 image-orientation:
// from-image 를 기본값으로 써서 <img>/canvas 가 이미 방향을 자동으로 맞춰 그린다.
// 여기서 방향을 또 보정하면 이미 맞는 사진을 다시 돌려 오히려 눕히게 된다.)

function isHeic(file) {
  const type = (file.type || "").toLowerCase();
  if (type === "image/heic" || type === "image/heif") return true;
  // 아이폰 사파리는 종종 type 을 빈 문자열로 주므로 확장자도 같이 본다.
  return /\.hei[cf]$/i.test(file.name || "");
}

// heic2any 는 내부적으로 WASM 디코더(libheif)를 쓰는 무거운 라이브러리라,
// HEIC 사진일 때만 그 시점에 불러온다.
async function toJpegIfHeic(file) {
  if (!isHeic(file)) return file;
  const { default: heic2any } = await import("https://esm.sh/heic2any@0.0.4");
  const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  return Array.isArray(out) ? out[0] : out; // 라이브 포토 등 다중 프레임이면 첫 장만 사용
}

function loadImage(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
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

  const jpegFile = await toJpegIfHeic(file);
  const img = await loadImage(jpegFile);
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
