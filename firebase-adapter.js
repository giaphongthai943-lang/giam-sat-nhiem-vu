/* Cầu nối Firebase cho trang Giám sát nhiệm vụ.
 * Trang gốc được viết cho claude.ai (window.claude.use('db' | 'user' | 'downloads')).
 * File này dựng lại đúng giao diện đó bằng Firebase (Firestore + đăng nhập Google),
 * để trang chạy được trên GitHub Pages / tên miền riêng mà không phải sửa mã trang.
 *
 * Phân quyền (được khóa ở luật Firestore, xem firestore.rules):
 *  - Quản trị: Gmail ghi trong luật Firestore → giao, sửa, duyệt, nhập Excel, danh mục.
 *  - Chuyên viên: Gmail có trong bộ sưu tập "chuyenVien" → báo hoàn thành.
 *  - Mọi người: chỉ xem, nếu quản trị bật "Cho xem công khai".
 */
(function () {
  'use strict';
  var CFG = window.FIREBASE_CONFIG;
  if (!window.firebase) { window.__fbErr = 'Không tải được thư viện Firebase. Kiểm tra kết nối mạng rồi tải lại trang.'; return; }
  if (!CFG || !CFG.apiKey || /^DIEN_/.test(CFG.apiKey)) { window.__fbErr = 'Chưa cấu hình Firebase: mở file firebase-config.js và dán cấu hình của dự án Firebase.'; return; }

  firebase.initializeApp(CFG);
  var auth = firebase.auth();
  var fs = firebase.firestore();
  // Bỏ qua trường chưa có giá trị (undefined) thay vì báo lỗi khi lưu
  try { fs.settings({ ignoreUndefinedProperties: true, merge: true }); } catch (e) {}

  /* ---- Đăng nhập: chờ Firebase cho biết đang là ai ---- */
  var authReady = new Promise(function (res) {
    var off = auth.onAuthStateChanged(function (u) { off(); res(u); });
  });
  try { auth.getRedirectResult().catch(function () {}); } catch (e) {}

  function lower(s) { return String(s || '').trim().toLowerCase(); }

  /* ---- Xác định vai trò (một lần mỗi lần tải trang) ---- */
  var roleP = authReady.then(function (u) {
    if (!u) return { user: null, owner: false, staff: false };
    // Quản trị: chỉ quản trị đọc được quanTri/kiemTra (luật Firestore)
    return fs.doc('quanTri/kiemTra').get().then(function () { return true; }, function () { return false; })
      .then(function (owner) {
        if (owner) return { user: u, owner: true, staff: true };
        return fs.doc('chuyenVien/' + lower(u.email)).get()
          .then(function (d) { return d.exists; }, function () { return false; })
          .then(function (staff) { return { user: u, owner: false, staff: staff }; });
      })
      .then(function (r) {
        // Lưu tên hiển thị để người khác thấy ai đã báo hoàn thành
        fs.doc('nguoiDung/' + u.uid).set({ ten: u.displayName || '', email: u.email || '', lanCuoi: new Date().toISOString() }, { merge: true }).catch(function () {});
        return r;
      });
  });

  /* ---- user: me / can / profiles ---- */
  var nameCache = {};
  var userApi = {
    me: function () {
      return roleP.then(function (r) {
        var u = r.user;
        return { id: u ? u.uid : null, isOwner: r.owner, name: u ? (u.displayName || '') : '', email: u ? u.email : null };
      });
    },
    can: function (perm) { return roleP.then(function (r) { return perm === 'data.write' ? (r.owner || r.staff) : false; }); },
    profiles: function (ids) {
      return roleP.then(function (r) {
        if (!r.staff) return {};
        var need = ids.filter(function (id) { return id && !(id in nameCache) && !/[\/]/.test(id); });
        return Promise.all(need.map(function (id) {
          return fs.doc('nguoiDung/' + id).get().then(function (d) {
            nameCache[id] = d.exists ? { id: id, name: d.data().ten || d.data().email || '' } : null;
          }, function () { nameCache[id] = null; });
        })).then(function () {
          var out = {};
          ids.forEach(function (id) { if (nameCache[id]) out[id] = nameCache[id]; });
          return out;
        });
      });
    }
  };

  /* ---- downloads: lưu file bằng thẻ <a download> ---- */
  var downloadsApi = {
    save: function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data]);
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = o.filename || 'tai-ve';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      return Promise.resolve({ status: 'saved' });
    }
  };

  /* ---- Giả lập window.claude ---- */
  window.claude = {
    use: function (name) {
      if (name === 'db') return roleP.then(function () { return fs; });
      if (name === 'user') return Promise.resolve(userApi);
      if (name === 'downloads') return Promise.resolve(downloadsApi);
      return Promise.resolve(null);
    }
  };

  /* ---- Nút đăng nhập / đăng xuất ở đầu trang ---- */
  function signIn() {
    var p = new firebase.auth.GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    auth.signInWithPopup(p).then(function () { location.reload(); }, function (e) {
      var c = e && e.code;
      if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-this-environment' || c === 'auth/cancelled-popup-request') auth.signInWithRedirect(p);
      else if (c !== 'auth/popup-closed-by-user') alert('Không đăng nhập được: ' + ((e && e.message) || c));
    });
  }
  function signOut() { auth.signOut().then(function () { location.reload(); }); }

  function mountAuthChip() {
    var meta = document.querySelector('.hero .meta');
    if (!meta || document.getElementById('authChip')) return;
    var wrap = document.createElement('span');
    wrap.id = 'authChip'; wrap.style.display = 'contents';
    meta.appendChild(wrap);
    roleP.then(function (r) {
      var u = r.user;
      if (!u) {
        wrap.innerHTML = '<button type="button" class="chip-m role" id="btnLogin" style="cursor:pointer">Đăng nhập Google</button>';
        document.getElementById('btnLogin').onclick = signIn;
      } else {
        var who = document.createElement('span');
        who.className = 'chip-m'; who.textContent = u.email || u.displayName || 'Đã đăng nhập';
        if (!r.staff) who.title = 'Gmail này chưa được cấp quyền báo hoàn thành';
        var out = document.createElement('button');
        out.type = 'button'; out.className = 'chip-m'; out.style.cursor = 'pointer'; out.textContent = 'Đăng xuất';
        out.onclick = signOut;
        wrap.appendChild(who); wrap.appendChild(out);
      }
    });
  }

  /* ---- Mục "Quyền truy cập" trong hộp Danh mục (chỉ quản trị) ---- */
  function mountAccessSettings() {
    var dlg = document.getElementById('dlgCfg');
    if (!dlg || document.getElementById('acc_box')) return;
    var body = dlg.querySelector('.dlg-b');
    var box = document.createElement('div');
    box.id = 'acc_box'; box.hidden = true;
    box.style.cssText = 'display:grid;gap:10px;border-top:1px solid var(--line);padding-top:14px';
    box.innerHTML =
      '<div style="font-weight:700;font-size:13.5px">Quyền truy cập</div>' +
      '<label class="fld"><span>Gmail chuyên viên được báo hoàn thành (mỗi dòng một Gmail)</span><textarea class="in" id="acc_staff" rows="5" placeholder="vidu@gmail.com"></textarea></label>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px"><input type="checkbox" id="acc_public" style="margin-top:3px"> <span><b>Cho xem công khai:</b> ai có đường link cũng xem được dashboard và trình chiếu mà không cần đăng nhập (chỉ xem, không sửa được).</span></label>' +
      '<div class="hint" id="acc_hint">Gmail quản trị được ghi cố định trong luật Firestore, không cần thêm ở đây.</div>';
    body.appendChild(box);

    var loaded = null;
    roleP.then(function (r) {
      if (!r.owner) return;
      box.hidden = false;
      var orig = dlg.showModal.bind(dlg);
      dlg.showModal = function () {
        orig();
        document.getElementById('acc_hint').textContent = 'Đang tải danh sách…';
        Promise.all([
          fs.collection('chuyenVien').get(),
          fs.doc('config/congKhai').get()
        ]).then(function (res) {
          var list = res[0].docs.map(function (d) { return d.id; }).sort();
          loaded = list;
          document.getElementById('acc_staff').value = list.join('\n');
          document.getElementById('acc_public').checked = !!(res[1].exists && res[1].data().xemCongKhai);
          document.getElementById('acc_hint').textContent = 'Gmail quản trị được ghi cố định trong luật Firestore, không cần thêm ở đây.';
        }, function (e) {
          document.getElementById('acc_hint').textContent = 'Không tải được danh sách quyền: ' + ((e && e.code) || e);
        });
      };
      document.getElementById('cf_ok').addEventListener('click', function () {
        if (!loaded) return;
        var want = [];
        document.getElementById('acc_staff').value.split(/[\n,;]+/).forEach(function (x) {
          x = lower(x); if (x && x.indexOf('@') > 0 && want.indexOf(x) < 0) want.push(x);
        });
        var batch = fs.batch();
        want.forEach(function (m) { if (loaded.indexOf(m) < 0) batch.set(fs.doc('chuyenVien/' + m), { themLuc: new Date().toISOString() }); });
        loaded.forEach(function (m) { if (want.indexOf(m) < 0) batch.delete(fs.doc('chuyenVien/' + m)); });
        batch.set(fs.doc('config/congKhai'), { xemCongKhai: document.getElementById('acc_public').checked }, { merge: true });
        batch.commit().then(function () { loaded = want.slice(); }, function (e) { alert('Không lưu được quyền truy cập: ' + ((e && e.code) || e)); });
      });
    });
  }

  function mount() { mountAuthChip(); mountAccessSettings(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
