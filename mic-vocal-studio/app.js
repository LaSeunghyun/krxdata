/* =========================================================
   MIC VOCAL — 공통 앱 로직 (shell · data · utils)
========================================================= */
(function(){
const KRW = n => '₩' + Number(n).toLocaleString('ko-KR');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = (s,el=document)=>el.querySelector(s);
const $$ = (s,el=document)=>[...el.querySelectorAll(s)];
const store = {
  get(k,d){try{return JSON.parse(localStorage.getItem('mic3_'+k))??d}catch(e){return d}},
  set(k,v){localStorage.setItem('mic3_'+k,JSON.stringify(v))}
};
const ic = (name,fill=0,cls='')=>`<span aria-hidden="true" class="material-symbols-outlined ${cls}"${fill?` style="font-variation-settings:'FILL' 1"`:''}>${name}</span>`;

/* ---------- 실제 @vocalmic 영상 데이터 ---------- */
const VIDEOS = [
  {id:'gH5VAv8wg5w', title:'아이유노래 잘 부르는 법? 실제 보컬레슨영상 100% 공개합니다', dur:'2:47', cat:'발성', feat:true},
  {id:'9HrcMTS66iI', title:'조유리가 아이즈원 메인보컬이었던 이유 (보컬분석)', dur:'4:48', cat:'보컬분석'},
  {id:'Xch6edMtRMw', title:'오디션에서 진짜 중요한 건 바로 이겁니다', dur:'3:09', cat:'오디션'},
  {id:'Ly0WaG5-Nwk', title:'발성연습, 이것만 한다고 노래가 늘까?', dur:'3:28', cat:'발성'},
  {id:'MsQt1AjI91E', title:"음색 미쳐버린 여학생의 '아이유 - Love poem' 커버", dur:'1:36', cat:'레슨후기'},
  {id:'WZD9peX3c6k', title:'뉴진스 의상이 별로라고? 신인개발팀 모셨습니다 (+오디션곡추천)', dur:'4:05', cat:'오디션'},
  {id:'Dl0H6-BuhqM', title:'4세대 아이돌가수 메인보컬의 바이브레이션은 어떨까?', dur:'3:23', cat:'보컬분석'},
  {id:'bwH6agCKaU0', title:"벌써 135만명이 본 노래방 개꿀팁 '3가지'", dur:'3:34', cat:'발성'},
  {id:'0PsrW4AcPoY', title:"'음색흙수저'가 태연 음색 장착하는 법 (중학생보컬레슨)", dur:'3:47', cat:'레슨후기'},
  {id:'x4oLqq4aJFw', title:'약점 극복에 성공한 사람들 TOP10', dur:'6:42', cat:'동기부여'},
  {id:'n9fphASr8Jo', title:'(녹음빨?) 상위1% 가수들이 고전하는 이유', dur:'3:56', cat:'보컬분석'},
  {id:'bkq5qaID-qE', title:'보컬레슨에 돈 때려박는데 노래 안 느는 애들 특;', dur:'2:44', cat:'동기부여'},
];
const VIDEO_CATS = ['전체','발성','오디션','보컬분석','레슨후기','동기부여'];

const COACHES = [
  {id:'lee', name:'이도현', role:'보컬 디렉터 · 발성', emoji:'🧑‍🎤', tint:'#2e5bff', tags:['발성교정','고음마스터'], price:80000, fee:'1:1 · 50분', bio:'前 방송사 보컬 트레이너. 믹스보이스·고음 전문.', joinDate:'2023-03-01', active:true, pay:{type:'revenue', rate:0.5}},
  {id:'choi', name:'최서아', role:'R&B · Soul 코치', emoji:'👩‍🎤', tint:'#7c4dff', tags:['R&B','감정표현'], price:75000, fee:'1:1 · 50분', bio:'세션 보컬리스트. 발라드·R&B 표현력 코칭.', joinDate:'2024-01-15', active:true, pay:{type:'revenue', rate:0.45}},
  {id:'jung', name:'정민재', role:'랩 · 힙합 코치', emoji:'🧔‍♂️', tint:'#00b8d4', tags:['플로우','딕션'], price:70000, fee:'1:1 · 50분', bio:'현역 래퍼. 플로우·딕션·작사 지도.', joinDate:'2025-09-01', active:true, pay:{type:'hourly', rate:35000}},
  {id:'kim', name:'김하늘', role:'오디션 디렉터', emoji:'👩‍🦰', tint:'#ff5c8a', tags:['입시','무대'], price:90000, fee:'1:1 · 60분', bio:'실용음악과 입시 다수 합격 지도.', joinDate:'2022-06-01', active:true, pay:{type:'revenue', rate:0.55}},
];

const PASSES = [
  {id:'p4', name:'4회권', desc:'가볍게 시작하는 체험형', price:200000, old:220000, per:'50,000원/회', perks:['1:1 레슨 4회','보이스 진단 리포트','연습실 무료 2회']},
  {id:'p12', name:'12회권', desc:'가장 많이 선택하는 정규반', price:540000, old:660000, per:'45,000원/회', perks:['1:1 레슨 12회','VOD 콘텐츠 무제한','연습실 무료 8회','녹음 피드백 3회'], feat:true},
  {id:'pm', name:'정기권', desc:'데뷔·입시 집중반 풀패스', price:390000, old:null, per:'월 정기결제', perks:['주 2회 정규 레슨','VOD 전체 + 신규 강의','연습실 무제한','월 1회 모의 무대']},
];

/* ---------- 공통 셸: 상단바 + 역할별 하단 탭 ---------- */
const NAV_ITEMS = {
  home:{key:'home',label:'홈',icon:'home',href:'index.html'},
  class:{key:'class',label:'클래스',icon:'calendar_month',href:'booking.html'},
  coachspace:{key:'coachspace',label:'강사',icon:'co_present',href:'coach.html'},
  admin:{key:'admin',label:'원장',icon:'workspace_premium',href:'admin.html'},
  community:{key:'community',label:'커뮤니티',icon:'forum',href:'community.html'},
  my:{key:'my',label:'마이',icon:'person',href:'mypage.html'},
};
function navFor(role){
  if(role==='director') return ['home','class','admin','community','my'].map(k=>NAV_ITEMS[k]);
  if(role==='coach') return ['home','class','coachspace','community','my'].map(k=>NAV_ITEMS[k]);
  if(role==='student') return ['home','class','community','my'].map(k=>NAV_ITEMS[k]);
  return ['home','community'].map(k=>NAV_ITEMS[k]); // visitor
}
function renderChrome(opt){
  opt = opt || {};
  const active = opt.active;
  const title = opt.title || 'MIC VOCAL';
  const back = opt.back;
  const A = window.MIC.auth;
  const user = A ? A.current() : null;
  const role = A ? A.role() : 'visitor';
  // top bar
  const top = document.createElement('header');
  top.className = 'fixed top-0 w-full z-50 bg-surface-dim border-b border-outline-variant/10';
  top.innerHTML = `<div class="flex justify-between items-center px-container-margin h-16 w-full max-w-[720px] mx-auto">
    ${back
      ? `<button onclick="history.length>1?history.back():location.href='index.html'" aria-label="뒤로" class="w-10 h-10 -ml-2 flex items-center justify-center text-on-surface-variant hover:opacity-80 active:scale-95 transition">${ic('arrow_back')}</button>`
      : `<button aria-label="마이크" class="w-10 h-10 flex items-center justify-start text-primary hover:opacity-80 active:scale-95 transition">${ic('mic_external_on',1)}</button>`}
    <h1 class="font-display-lg text-[22px] font-extrabold text-primary tracking-tighter ${back?'':'absolute left-1/2 -translate-x-1/2'} uppercase">${esc(title)}</h1>
    ${user
      ? `<button id="mic-logout" aria-label="${esc(user.name)} 로그아웃" class="h-9 pl-2 pr-1 flex items-center gap-1.5 rounded-full hover:bg-surface-container active:scale-95 transition"><span class="font-label-sm text-label-sm text-on-surface-variant">${esc(user.name)}</span><span class="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-primary">${ic('logout','','text-[18px]')}</span></button>`
      : `<a href="login.html" class="h-9 px-3.5 flex items-center rounded-full bg-primary/15 text-primary font-label-sm text-label-sm border border-primary/20 active:scale-95 transition">로그인</a>`}
  </div>`;
  document.body.prepend(top);
  // bottom nav (role-based)
  if(active){
    const nav = document.createElement('nav');
    nav.className = 'fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[720px] flex justify-around items-center py-base pb-safe bg-surface-container border-t border-outline-variant/10 z-50 rounded-t-xl';
    nav.innerHTML = navFor(role).map(n=>{
      const on = n.key===active;
      return `<a href="${n.href}"${on?' aria-current="page"':''} class="flex flex-col items-center justify-center w-16 gap-1 active:scale-90 transition-all duration-200 ${on?'text-primary font-bold':'text-on-surface-variant hover:text-primary/80'}">
        ${ic(n.icon, on?1:0)}<span class="font-label-sm text-label-sm">${n.label}</span></a>`;
    }).join('');
    document.body.appendChild(nav);
  }
  const lo = document.getElementById('mic-logout');
  if(lo) lo.addEventListener('click', ()=>{ A.logout(); location.href='index.html'; });
  injectGlobals();
}

/* ---------- 영상 콘텐츠 (동적: 추가/삭제) ---------- */
function getVideos(){ let v = store.get('videos', null); if(!v){ v = VIDEOS.slice(); store.set('videos', v); } return v; }
function addVideo(v){ const list = getVideos(); list.unshift(v); store.set('videos', list); }
function removeVideo(id){ store.set('videos', getVideos().filter(x=>x.id!==id)); }

/* ---------- 영상 모달 + 토스트 (전역 1회 주입) ---------- */
let _lastFocus=null, _vRelease=null;
function injectGlobals(){
  if(document.getElementById('mic-video-modal')) return;
  const m = document.createElement('div');
  m.id='mic-video-modal';
  m.className='modal-overlay fixed inset-0 z-[100] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4';
  m.innerHTML=`<div class="sheet w-full max-w-[720px]" role="dialog" aria-modal="true" aria-label="영상 재생">
    <div class="flex justify-end mb-2"><button data-vclose class="w-10 h-10 rounded-full bg-surface-container text-on-surface flex items-center justify-center hover:bg-surface-variant" aria-label="닫기">${ic('close')}</button></div>
    <div class="rounded-2xl overflow-hidden bg-black aspect-video"><iframe id="mic-vframe" class="w-full h-full" title="보컬 강의 영상" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen></iframe></div>
    <h4 id="mic-vtitle" class="font-body-lg text-body-lg text-on-surface mt-4 px-1"></h4>
    <p class="font-label-sm text-label-sm text-on-surface-variant mt-1 px-1 flex items-center gap-1">${ic('verified',1,'text-[16px] text-primary')} 마이크보컬스튜디오 · YouTube</p>
  </div>`;
  document.body.appendChild(m);
  m.addEventListener('click',e=>{ if(e.target===m || e.target.closest('[data-vclose]')) closeVideo(); });

  const t = document.createElement('div');
  t.id='mic-toast';
  t.className='fixed bottom-[96px] left-1/2 -translate-x-1/2 z-[110] w-[calc(100%-40px)] max-w-[420px] bg-surface-container-high border border-outline-variant/20 rounded-2xl px-4 py-3 flex items-start gap-3 shadow-2xl';
  t.style.borderLeftWidth='3px';
  t.innerHTML=`<span id="mic-toast-ic" class="material-symbols-outlined text-success" style="font-variation-settings:'FILL' 1">check_circle</span>
    <div><div id="mic-toast-title" class="font-label-md text-label-md text-on-surface"></div><div id="mic-toast-desc" class="font-label-sm text-label-sm text-on-surface-variant"></div></div>`;
  document.body.appendChild(t);

  document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeVideo(); });

  // 모든 Material Symbols 아이콘을 스크린리더에서 숨김 (리거처 텍스트 노출 방지)
  const hideIcons = root => (root.querySelectorAll?.('.material-symbols-outlined:not([aria-hidden])')||[]).forEach(e=>e.setAttribute('aria-hidden','true'));
  hideIcons(document);
  new MutationObserver(muts=>muts.forEach(m=>m.addedNodes.forEach(n=>{
    if(n.nodeType!==1)return;
    if(n.classList&&n.classList.contains('material-symbols-outlined')&&!n.hasAttribute('aria-hidden')) n.setAttribute('aria-hidden','true');
    hideIcons(n);
  }))).observe(document.body,{childList:true,subtree:true});
}

/* ---------- focus trap (모달/시트 공용) ---------- */
function trapFocus(modal){
  const list=()=>[...modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el=>!el.disabled&&el.offsetParent!==null);
  function onKey(e){
    if(e.key!=='Tab')return;
    const els=list(); if(!els.length)return;
    const first=els[0], last=els[els.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }
  modal.addEventListener('keydown',onKey);
  setTimeout(()=>{const els=list();if(els.length)els[0].focus();},60);
  return ()=>modal.removeEventListener('keydown',onKey);
}
function openVideo(id,title){
  injectGlobals();
  _lastFocus=document.activeElement;
  $('#mic-vframe').src=`https://www.youtube.com/embed/${id}?autoplay=1&rel=0`;
  $('#mic-vtitle').textContent=title;
  $('#mic-video-modal').classList.add('show');
  document.body.style.overflow='hidden';
  _vRelease=trapFocus($('#mic-video-modal'));
}
function closeVideo(){
  const m=$('#mic-video-modal'); if(!m||!m.classList.contains('show'))return;
  m.classList.remove('show'); $('#mic-vframe').src=''; document.body.style.overflow='';
  if(_vRelease){_vRelease();_vRelease=null;}
  if(_lastFocus&&_lastFocus.focus)_lastFocus.focus();
}
let toastT;
function toast(title,desc,type='success'){
  injectGlobals();
  const el=$('#mic-toast'); const color = type==='error'?'#ffb4ab':type==='info'?'#b8c3ff':'#5bd49a';
  el.style.borderLeftColor=color;
  $('#mic-toast-ic').style.color=color;
  $('#mic-toast-ic').textContent = type==='error'?'error':type==='info'?'info':'check_circle';
  $('#mic-toast-title').textContent=title; $('#mic-toast-desc').textContent=desc||'';
  el.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('show'),3800);
}

/* ---------- scroll reveal ---------- */
function initReveal(){
  const io=new IntersectionObserver(es=>es.forEach(en=>{if(en.isIntersecting){en.target.classList.add('in');io.unobserve(en.target);}}),{threshold:.12});
  $$('.reveal').forEach(el=>io.observe(el));
}

/* ---------- expose ---------- */
window.MIC = { KRW, esc, $, $$, store, ic, VIDEOS, VIDEO_CATS, COACHES, PASSES,
  chrome:renderChrome, openVideo, closeVideo, toast, initReveal, trapFocus,
  getVideos, addVideo, removeVideo, navFor,
  thumb:id=>`https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
})();