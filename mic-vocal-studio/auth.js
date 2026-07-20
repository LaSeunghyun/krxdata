/* =========================================================
   MIC VOCAL — 인증·역할 (localStorage 데모)
   ⚠ 데모용: 비밀번호 평문 저장. 실서비스 금지(서버 인증 필요).
   역할: visitor(비로그인) · student · coach · director
========================================================= */
(function () {
  const store = window.MIC.store;

  // 시드 계정 (최초 1회)
  function seed() {
    if (store.get('users', null)) return;
    store.set('users', [
      { id: 'u_dir',  email: 'director@mic.com', pw: '1234', name: '한지원', role: 'director' },
      { id: 'u_lee',  email: 'lee@mic.com',  pw: '1234', name: '이도현', role: 'coach', coachId: 'lee' },
      { id: 'u_choi', email: 'choi@mic.com', pw: '1234', name: '최서아', role: 'coach', coachId: 'choi' },
      { id: 'u_jung', email: 'jung@mic.com', pw: '1234', name: '정민재', role: 'coach', coachId: 'jung' },
      { id: 'u_kim',  email: 'kim@mic.com',  pw: '1234', name: '김하늘', role: 'coach', coachId: 'kim' },
      { id: 'u_stu',  email: 'student@mic.com', pw: '1234', name: '박서연', role: 'student' },
    ]);
  }
  seed();

  const auth = {
    current() {
      const id = store.get('session', null);
      return id ? (store.get('users', []).find(u => u.id === id) || null) : null;
    },
    role() { const u = this.current(); return u ? u.role : 'visitor'; },
    login(email, pw) {
      const u = store.get('users', []).find(x => x.email === (email || '').trim().toLowerCase() && x.pw === pw);
      if (u) { store.set('session', u.id); return u; }
      return null;
    },
    logout() { store.set('session', null); },
    signup(data) {
      const email = (data.email || '').trim().toLowerCase();
      const users = store.get('users', []);
      if (!email || !data.pw || !data.name) return { error: '모든 항목을 입력하세요' };
      if (users.some(u => u.email === email)) return { error: '이미 가입된 이메일입니다' };
      const u = { id: 'u_' + Date.now(), email, pw: data.pw, name: data.name.trim(), role: 'student' };
      users.push(u); store.set('users', users); store.set('session', u.id);
      return { user: u };
    },
    users() { return store.get('users', []); },
    setRole(id, role) {
      const users = store.get('users', []);
      const u = users.find(x => x.id === id);
      if (u) { u.role = role; store.set('users', users); }
    },
    // 페이지 가드: 권한 없으면 로그인으로
    requireRole(page) {
      if (!window.DOMAIN.canAccess(this.role(), page)) {
        const to = encodeURIComponent(location.pathname.split('/').pop() || 'index.html');
        location.replace('login.html?to=' + to);
        return false;
      }
      return true;
    },
  };
  window.MIC.auth = auth;
})();
