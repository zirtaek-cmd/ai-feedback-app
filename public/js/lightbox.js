// 제출 이미지 클릭 시 전체 화면으로 크게 보여주는 라이트박스.
// data: URL을 새 탭(target="_blank")으로 열면 일부 브라우저에서 빈 화면이 뜨는
// 문제가 있어, 페이지 안에서 오버레이로 보여주는 방식을 쓴다.
let overlay = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.innerHTML = `<img class="lightbox-img" alt="확대 이미지">`;
  overlay.addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });
  document.body.appendChild(overlay);
  return overlay;
}

export function openLightbox(src) {
  const el = ensureOverlay();
  el.querySelector("img").src = src;
  el.classList.add("open");
}

export function closeLightbox() {
  if (overlay) overlay.classList.remove("open");
}

// 컨테이너 안의 .imgs img 요소들에 클릭 시 라이트박스가 뜨도록 연결한다.
export function wireLightboxImages(container) {
  container.querySelectorAll(".imgs img").forEach((img) => {
    img.addEventListener("click", () => openLightbox(img.src));
  });
}
