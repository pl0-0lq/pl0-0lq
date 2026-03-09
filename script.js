const letterInput = document.getElementById("letterInput");
const photoInput = document.getElementById("photoInput");
const itemsInput = document.getElementById("itemsInput");
const startBtn = document.getElementById("startBtn");
const shareBtn = document.getElementById("shareBtn");
const downloadBtn = document.getElementById("downloadBtn");

const gameSection = document.getElementById("gameSection");
const revealSection = document.getElementById("revealSection");
const progressText = document.getElementById("progressText");
const puzzleImage = document.getElementById("puzzleImage");
const hotspotLayer = document.getElementById("hotspotLayer");
const itemBar = document.getElementById("itemBar");
const slideshow = document.getElementById("slideshow");
const letterView = document.getElementById("letterView");

const itemTemplate = document.getElementById("itemTemplate");
const PORTABLE_CSS = `
:root { color-scheme: light; font-family: "Pretendard", "Noto Sans KR", system-ui, -apple-system, sans-serif; --line: #e6e8f4; }
* { box-sizing: border-box; }
body { margin:0; background:#f8f9ff; color:#1c2540; }
.app { max-width:980px; margin:0 auto; padding:24px 16px; }
.card { border:1px solid var(--line); border-radius:16px; background:#fff; box-shadow:0 12px 24px rgba(22,26,56,.06); padding:16px; margin-top:16px; }
.hidden { display:none; }
.puzzle-wrap { margin-top:10px; position:relative; width:min(100%,780px); aspect-ratio:4/3; border-radius:12px; overflow:hidden; border:1px solid var(--line); }
#puzzleImage { width:100%; height:100%; object-fit:cover; }
#hotspotLayer { position:absolute; inset:0; }
.hotspot { position:absolute; width:11%; aspect-ratio:1; border-radius:999px; border:2px dashed rgba(255,255,255,.5); transform:translate(-50%,-50%); background:transparent; }
.hotspot.found { border-style:solid; border-color:rgba(66,245,120,.95); background:rgba(66,245,120,.2); }
.item-bar { margin-top:12px; display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:8px; }
.item-chip { border:0; border-radius:10px; padding:10px 14px; background:#edf0ff; text-align:left; }
.item-chip.found { background:#d6f8e2; text-decoration:line-through; }
.slideshow { position:relative; height:min(50vw,320px); border-radius:12px; overflow:hidden; border:1px solid var(--line); }
.slide { position:absolute; inset:0; background-size:cover; background-position:center; opacity:0; transition:opacity 1.8s ease; filter:saturate(.9) brightness(.93); }
.slide.on { opacity:.42; }
.letter { margin-top:12px; min-height:220px; max-height:340px; overflow:auto; border-radius:12px; border:1px solid var(--line); background:rgba(255,255,255,.88); padding:16px; white-space:pre-wrap; line-height:1.55; opacity:0; transform:translateY(70px); animation:letter-rise 4s ease forwards; }
@keyframes letter-rise { to { opacity:1; transform:translateY(0); } }
`;

const state = {
  letterText: "",
  photos: [],
  puzzlePhoto: "",
  timelinePhotos: [],
  items: [],
  found: new Set(),
  timer: null,
};

itemsInput.value = "야구공, 냄비, 사과, 컵, 열쇠, 모자, 연필, 시계, 꽃, 우산";

startBtn.addEventListener("click", async () => {
  const letterFile = letterInput.files?.[0];
  const photoFiles = [...(photoInput.files || [])];

  if (!letterFile || photoFiles.length < 2) {
    alert("편지 파일 1개와 사진 최소 2장을 넣어주세요.");
    return;
  }

  const items = parseItems(itemsInput.value);
  if (items.length !== 10) {
    alert("숨은 그림 이름은 정확히 10개여야 합니다.");
    return;
  }

  const letterText = await letterFile.text();
  const photoData = await Promise.all(photoFiles.map(fileToDataUrl));

  state.letterText = letterText;
  state.photos = photoData;
  state.puzzlePhoto = photoData[0];
  state.timelinePhotos = photoData.slice(1);
  state.items = items;
  state.found.clear();

  buildPuzzle();
  buildReveal();

  shareBtn.disabled = false;
  downloadBtn.disabled = false;
});

shareBtn.addEventListener("click", async () => {
  try {
    const file = makePortablePageFile();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: "편지와 추억 페이지",
        text: "편지와 사진이 들어간 숨은그림 페이지예요.",
        files: [file],
      });
      return;
    }
    alert("이 환경에서는 직접 공유를 지원하지 않습니다. '완성 페이지 파일 저장'으로 저장 후 전달해 주세요.");
  } catch (error) {
    alert(`공유에 실패했습니다: ${error.message}`);
  }
});

downloadBtn.addEventListener("click", () => {
  const file = makePortablePageFile();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1500);
});

function parseItems(raw) {
  return raw
    .split(",")
    .map(v => v.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function buildPuzzle() {
  gameSection.classList.remove("hidden");
  revealSection.classList.add("hidden");
  progressText.textContent = `0 / ${state.items.length} 찾음`;

  puzzleImage.src = state.puzzlePhoto;
  hotspotLayer.innerHTML = "";
  itemBar.innerHTML = "";

  const points = makeDeterministicPoints(state.items.length);

  state.items.forEach((item, i) => {
    const chip = itemTemplate.content.firstElementChild.cloneNode(true);
    chip.textContent = item;
    chip.dataset.item = item;
    itemBar.appendChild(chip);

    const spot = document.createElement("button");
    spot.className = "hotspot";
    spot.style.left = `${points[i].x}%`;
    spot.style.top = `${points[i].y}%`;
    spot.dataset.item = item;
    spot.title = `${item} 찾기`;

    spot.addEventListener("click", () => {
      if (state.found.has(item)) return;
      state.found.add(item);
      spot.classList.add("found");
      chip.classList.add("found");
      progressText.textContent = `${state.found.size} / ${state.items.length} 찾음`;
      if (state.found.size === state.items.length) {
        setTimeout(startReveal, 650);
      }
    });

    hotspotLayer.appendChild(spot);
  });
}

function buildReveal() {
  letterView.textContent = state.letterText;
  slideshow.innerHTML = "";

  state.timelinePhotos.forEach((src, idx) => {
    const slide = document.createElement("div");
    slide.className = "slide";
    if (idx === 0) slide.classList.add("on");
    slide.style.backgroundImage = `url('${src}')`;
    slideshow.appendChild(slide);
  });
}

function startReveal() {
  revealSection.classList.remove("hidden");
  const slides = [...slideshow.querySelectorAll(".slide")];
  if (!slides.length) return;

  let index = 0;
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    slides[index].classList.remove("on");
    index = (index + 1) % slides.length;
    slides[index].classList.add("on");
  }, 2200);

  revealSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function makeDeterministicPoints(count) {
  const output = [];
  let seed = 123456;
  for (let i = 0; i < count; i += 1) {
    seed = (1664525 * seed + 1013904223) % 4294967296;
    const x = 12 + (seed % 76);
    seed = (1664525 * seed + 1013904223) % 4294967296;
    const y = 16 + (seed % 66);
    output.push({ x, y });
  }
  return output;
}

function makePortablePageFile() {
  const payload = {
    letterText: state.letterText,
    photos: state.photos,
    items: state.items,
  };

  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>공유된 편지 숨은그림 페이지</title>
<style>${PORTABLE_CSS}</style>
</head>
<body>
  <script>
    window.__payload = ${JSON.stringify(payload).replace(/</g, "\\u003c")};
  </script>
  <script>
    ${portableScript()}
  </script>
</body>
</html>`;

  return new File([html], "letter-memory-page.html", { type: "text/html" });
}

function portableScript() {
  return `
    document.body.innerHTML = '<main class="app"><section class="card game"><h2>숨은 그림찾기</h2><p id="progressText">0 / 10 찾음</p><div class="puzzle-wrap"><img id="puzzleImage" alt="숨은 그림찾기 배경"><div id="hotspotLayer"></div></div><div id="itemBar" class="item-bar"></div></section><section id="revealSection" class="card reveal hidden"><h2>추억 재생 + 편지</h2><div id="slideshow" class="slideshow"></div><article id="letterView" class="letter"></article></section></main>';
    const payload = window.__payload;
    const state = { found: new Set() };
    const puzzleImage = document.getElementById('puzzleImage');
    const hotspotLayer = document.getElementById('hotspotLayer');
    const itemBar = document.getElementById('itemBar');
    const progressText = document.getElementById('progressText');
    const revealSection = document.getElementById('revealSection');
    const slideshow = document.getElementById('slideshow');
    const letterView = document.getElementById('letterView');

    puzzleImage.src = payload.photos[0];
    letterView.textContent = payload.letterText;
    payload.photos.slice(1).forEach((src, idx) => {
      const slide = document.createElement('div');
      slide.className = 'slide' + (idx === 0 ? ' on' : '');
      slide.style.backgroundImage = 'url(' + src + ')';
      slideshow.appendChild(slide);
    });

    function makePoints(n){
      const out=[]; let s=123456;
      for(let i=0;i<n;i++){ s=(1664525*s+1013904223)%4294967296; const x=12+(s%76); s=(1664525*s+1013904223)%4294967296; const y=16+(s%66); out.push({x,y}); }
      return out;
    }

    const points = makePoints(payload.items.length);
    payload.items.forEach((item, i) => {
      const chip = document.createElement('button');
      chip.className='item-chip'; chip.textContent=item; itemBar.appendChild(chip);
      const spot = document.createElement('button');
      spot.className='hotspot';
      spot.style.left = points[i].x + '%';
      spot.style.top = points[i].y + '%';
      spot.addEventListener('click', () => {
        if(state.found.has(item)) return;
        state.found.add(item);
        spot.classList.add('found');
        chip.classList.add('found');
        progressText.textContent = state.found.size + ' / ' + payload.items.length + ' 찾음';
        if(state.found.size===payload.items.length){
          revealSection.classList.remove('hidden');
          const slides=[...document.querySelectorAll('.slide')];
          let idx=0;
          setInterval(()=>{ slides[idx].classList.remove('on'); idx=(idx+1)%slides.length; slides[idx].classList.add('on'); },2200);
          revealSection.scrollIntoView({behavior:'smooth'});
        }
      });
      hotspotLayer.appendChild(spot);
    });
  `;
}
