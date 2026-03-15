const firebaseConfig = {
    apiKey: "AIzaSyC7AbLX8taDVa_kqlLTmAlCrNbb3Ykakbo",
    authDomain: "babakteam-b9ac4.firebaseapp.com",
    projectId: "babakteam-b9ac4",
    storageBucket: "babakteam-b9ac4.firebasestorage.app",
    messagingSenderId: "497412807764",
    appId: "1:497412807764:web:096f6fd1342c7ba66021c1"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
// ====== АВТО-НУМЕРАЦІЯ: лічильник у Firebase ======
async function getNextOrderNumber() {
    const counterRef = db.collection('meta').doc('orderCounter');
    return db.runTransaction(async (transaction) => {
        const doc = await transaction.get(counterRef);
        const nextNum = (doc.exists ? (doc.data().count || 0) : 0) + 1;
        transaction.set(counterRef, { count: nextNum });
        return nextNum;
    });
}
// Міграція — один раз присвоює orderNumber замовленням які його ще не мають.
// Критична правка: числа зберігаємо у локальну Map до batch.commit(),
// щоб не читати застарілий doc.data() після запису.
async function migrateOrderNumbers() {
    try {
        const snap = await db.collection('orders').orderBy('createdAt', 'asc').get();
        const needsNumber = snap.docs.filter(d => !d.data().orderNumber);
        if (needsNumber.length === 0) return;
        const counterRef = db.collection('meta').doc('orderCounter');
        const counterDoc = await counterRef.get();
        let currentCount = counterDoc.exists ? (counterDoc.data().count || 0) : 0;
        // Зберігаємо призначені числа локально ПЕРЕД записом
        const assignedMap = new Map(); // docId → orderNumber
        const batch = db.batch();
        needsNumber.forEach(doc => {
            currentCount++;
            assignedMap.set(doc.id, currentCount);
            batch.update(doc.ref, { orderNumber: currentCount });
        });
        batch.set(counterRef, { count: currentCount });
        await batch.commit();
        // Оновлюємо DOM з локальної Map (не з doc.data() — він ще застарілий)
        assignedMap.forEach((num, docId) => {
            const row = document.querySelector(`tr[data-order-id="${docId}"]`);
            if (row) {
                row.dataset.orderNumber = num;
                const numSpan = row.querySelector('.row-num');
                if (numSpan) numSpan.innerText = num;
            }
        });
        console.log(`✓ Міграція: присвоєно номери ${needsNumber.length} замовленням`);
    } catch(e) {
        console.warn('migrateOrderNumbers error:', e);
    }
}
const allowedUsers = ['адмін', 'виробництво', 'матвій', 'марта', 'юля', 'ксюша'];
const userColors = ['#ea6b48', '#3689e6', '#ea6b48', '#4b9a52', '#9b51e0', '#d08f5a']; 
let currentUser = localStorage.getItem('tabixAuthUser_v47') || null;
let userRole = 'limited'; 
let historyCheckInterval = null;
let saveTimeout = null; 
// --- СТАН ПАЗЛ-ФІЛЬТРА ---
let activeFilters = { status: [], product: [], color: [], size: [], design: [] };
let currentSearchQuery = '';
let undoStack = [];
let pendingServerHtml = null;
let pendingServerMenu = null;
let displayLimit = 20; // Лимит отображения заказов
function recordUndoState() {
    if (userRole === 'limited') return;
    const tempDiv = document.createElement('tbody');
    tempDiv.innerHTML = tbody.innerHTML;
    tempDiv.querySelectorAll('tr.selected').forEach(tr => tr.classList.remove('selected'));
    tempDiv.querySelectorAll('input.row-checkbox').forEach(cb => { cb.checked = false; cb.removeAttribute('checked'); });
    
    undoStack.push({
        html: tempDiv.innerHTML,
        menu: JSON.stringify(menuData)
    });
    if (undoStack.length > 20) undoStack.shift(); 
}
function performUndo() {
    if (userRole === 'limited') return;
    if (undoStack.length === 0) {
        showToast('Немає збережених кроків для скасування');
        return;
    }
    const prevState = undoStack.pop();
    applyHtmlFromServer(prevState.html);
    menuData = JSON.parse(prevState.menu);
    saveData(true); 
    showToast('Дію скасовано');
}
// Обробка гарячих клавіш Ctrl+Z та Ctrl+S
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
            return; 
        }
        e.preventDefault();
        performUndo();
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
        e.preventDefault();
        saveData();
        if (userRole === 'admin') {
            createHistoryBackup();
        }
        showToast('Збережено (додано в історію)');
    }
});
function initAuth() {
    if (currentUser && allowedUsers.includes(currentUser.toLowerCase())) {
        setupUserSession();
    } else { showLogin(); }
}
window.login = function() {
    const inputVal = document.getElementById('loginInput').value.trim().toLowerCase();
    if(allowedUsers.includes(inputVal)) {
        currentUser = inputVal; 
        localStorage.setItem('tabixAuthUser_v47', currentUser);
        document.getElementById('loginError').style.display = 'none'; 
        setupUserSession();
    } else { document.getElementById('loginError').style.display = 'block'; }
}
window.logout = function() {
    currentUser = null; userRole = 'limited'; localStorage.removeItem('tabixAuthUser_v47');
    hidePopover(document.getElementById('userMenu'));
    if(historyCheckInterval) clearInterval(historyCheckInterval);
    showLogin();
}
function showLogin() {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('loginInput').value = '';
    document.getElementById('loginError').style.display = 'none';
    setTimeout(() => document.getElementById('loginInput').focus(), 100);
}
function setupUserSession() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appContainer').style.display = 'flex';
    document.getElementById('topUserName').innerText = currentUser;
    document.getElementById('topAvatar').innerText = currentUser.charAt(0);
    
    const colorIdx = allowedUsers.indexOf(currentUser);
    document.documentElement.style.setProperty('--user-color', userColors[colorIdx] || '#3689e6');
    if (['виробництво'].includes(currentUser)) { userRole = 'limited'; }
    else { userRole = 'admin'; } 
document.body.className = `role-${userRole}`;
    // Дефолтний фільтр ДО завантаження — щоб "Відправлено" не рендерилось одразу
    if (activeFilters.status.length === 0) {
        activeFilters.status = FIXED_STATUSES
            .filter(s => s.text !== 'Відправлено')
            .map(s => s.text);
    }
    startCloudSync();
    startOrdersSync(); // <--- ДОБАВЛЕНО: запускаем прослушивание заказов с Make
    startAutoBackup();
    setTimeout(initDragAndDrop, 500);
}
// --- РОЗУМНЕ ПОЗИЦІОНУВАННЯ ПОПАПІВ ---
window.smartPosition = function(popover, rect, mode = 'bottom') {
    popover.style.visibility = 'hidden';
    popover.classList.add('active');
    
    const pW = popover.offsetWidth;
    const pH = popover.offsetHeight;
    const vW = window.innerWidth;
    const vH = window.innerHeight;
    
    let top, left;
    if (mode === 'bottom') {
        top = rect.bottom + 2; 
        left = rect.left;
        if (top + pH > vH - 10) top = rect.top - pH - 2; 
    } else {
        top = rect.top - 1; 
        left = rect.left - 1;
        if (top + pH > vH - 10) top = vH - pH - 10;
    }
    
    if (left + pW > vW - 10) left = vW - pW - 10; 
    if (left < 10) left = 10; 
    if (top < 10) top = 10; 
    
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.style.visibility = '';
};
window.showUserMenu = function(e, btn) {
    e.stopPropagation(); closeAllPopovers();
    const menu = document.getElementById('userMenu');
    window.smartPosition(menu, btn.getBoundingClientRect(), 'bottom');
}
const tbody = document.getElementById('tableBody');
const dropdownMenu = document.getElementById('dropdownMenu');
const dropdownOptions = document.getElementById('dropdownOptions');
const textInputPopover = document.getElementById('textInputPopover');
const cellInput = document.getElementById('cellInput');
const newTemplateMenu = document.getElementById('newTemplateMenu');
const templateOptions = document.getElementById('templateOptions');
const btnDelete = document.getElementById('btnDelete');
const scrollContainer = document.getElementById('scrollContainer');
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');
const globalCopyBtn = document.getElementById('globalCopyBtn');
const customModal = document.getElementById('customModal');
const modalInput = document.getElementById('modalInput');
const searchInput = document.getElementById('searchInput');
let currentEditingCell = null; let hoveredCopyCell = null; let hoveredRowForTemplate = null;
let pendingCommentCoords = null; let activeCommentPin = null;
let activePersList = []; let activeKopilkaSizes = []; let activeKopilkaDesigns = []; let activeKopilkaColors = [];
const colorPresets = [ 
    {bg: '#f3f3f2', color: '#37352f', border: '#e9e9e7'}, 
    {bg: '#e3e2e0', color: '#37352f'}, {bg: '#fdecc8', color: '#402c1b'}, {bg: '#fbf3db', color: '#4c3f20'}, 
    {bg: '#dbeede', color: '#1c3829'}, {bg: '#d3e5ef', color: '#183347'}, {bg: '#f4dfeb', color: '#4c2337'}, 
    {bg: '#ffdad6', color: '#492929'} 
];
window.kopilkaColors = [
    {name: 'Light wood', hex: '#f7dfc6'}, {name: 'Basic wood', hex: '#deb88b'}, {name: 'Walnut', hex: '#875b3b'},
    {name: 'White', hex: '#ffffff'}, {name: 'Black', hex: '#1c1b1c'}, {name: 'Gray', hex: '#b3b5b6'},
    {name: 'Yellow', hex: '#fce68f'}, {name: 'Blue', hex: '#a6dbf4'}, {name: 'Pink', hex: '#fbcad2'},
    {name: 'Asparagus', hex: '#b9d88f'}, {name: 'Purple', hex: '#b797cc'},
    // --- НОВЫЕ ЦВЕТА ---
    {name: 'Black Wood', hex: '#3b3633'}, {name: 'Teak', hex: '#d6613d'}
];
window.hwColors = [
    {name: 'Natural wood', hex: '#deb88b'},
    {name: 'Black', hex: '#1c1b1c'},
    {name: 'Asparagus', hex: '#b9d88f'}
];
window.hwSizes = ['XS', 'S', 'M', 'L'];
window.hwDesigns = ['+', '−'];
// === WISH TREE ===
window.wtColors = [
    {name: 'Light Wood', hex: '#f7dfc6'},
    {name: 'Walnut',     hex: '#875b3b'},
];
window.wtSizes = ['S', 'M', 'L'];
// Default statuses - fallback if Firebase has none
const FIXED_STATUSES = [
    { text: 'Нове',        class: 'badge-status', customStyle: 'background-color: #e3e2e0; color: #37352f;' },
    { text: 'Чекає макет', class: 'badge-status', customStyle: 'background-color: #fdecc8; color: #402c1b;' },
    { text: 'Передано',    class: 'badge-status', customStyle: 'background-color: #e8d5f5; color: #4a235a;' },
    { text: 'В роботі',    class: 'badge-status', customStyle: 'background-color: #d3e5ef; color: #183347;' },
    { text: 'Накладна',    class: 'badge-status', customStyle: 'background-color: #fff3cd; color: #6d4c00;' },
    { text: 'Відправка',   class: 'badge-status', customStyle: 'background-color: #ffe0b2; color: #6d3a00;' },
    { text: 'Відправлено', class: 'badge-status', customStyle: 'background-color: #dbeede; color: #1c3829;' },
];
let menuData = {
    'source':  [],
    'product': [],
    'status':  FIXED_STATUSES,
    'size': [
        { text: 'XS', class: 'badge-status', customStyle: 'background-color: #ffffff; color: #37352f; border: 1px solid #d1d1d1;' },
        { text: 'S',  class: 'badge-status', customStyle: 'background-color: #ffffff; color: #37352f; border: 1px solid #d1d1d1;' },
        { text: 'M',  class: 'badge-status', customStyle: 'background-color: #ffffff; color: #37352f; border: 1px solid #d1d1d1;' },
        { text: 'L',  class: 'badge-status', customStyle: 'background-color: #ffffff; color: #37352f; border: 1px solid #d1d1d1;' },
        { text: 'XL', class: 'badge-status', customStyle: 'background-color: #ffffff; color: #37352f; border: 1px solid #d1d1d1;' }
    ]
};
let rowTemplates = [{ name: 'Порожній рядок', data: [] }];
let unsubscribe = null;
function createHistoryBackup() {
    const tempDiv = document.createElement('tbody');
    tempDiv.innerHTML = tbody.innerHTML;
    tempDiv.querySelectorAll('tr.selected').forEach(tr => tr.classList.remove('selected'));
    tempDiv.querySelectorAll('input.row-checkbox').forEach(cb => { cb.checked = false; cb.removeAttribute('checked'); });
    db.collection("babak_crm_history").add({
        html: tempDiv.innerHTML,
        menu: menuData,
        templates: rowTemplates,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    db.collection("babak_crm").doc("main_state").update({ lastHistorySave: Date.now() }).catch(e=>{});
}
function startAutoBackup() {
    if (userRole !== 'admin') return;
    if (historyCheckInterval) clearInterval(historyCheckInterval);
    
    historyCheckInterval = setInterval(() => {
        db.collection("babak_crm").doc("main_state").get().then(doc => {
            if (doc.exists) {
                const data = doc.data();
                const now = Date.now();
                const lastSave = data.lastHistorySave || 0;
                if (now - lastSave >= 1200000) { createHistoryBackup(); }
            }
        });
    }, 60000);
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    db.collection("babak_crm_history").where("timestamp", "<", threeDaysAgo).get().then(snapshot => {
        snapshot.forEach(doc => doc.ref.delete());
    }).catch(e => {});
}
window.openHistoryModal = function() {
    closeAllPopovers();
    document.getElementById('historyModal').classList.add('active');
    const list = document.getElementById('historyList');
    list.innerHTML = '<div style="padding: 10px; text-align: center; color: var(--c-texSec); font-size: 13px;">Завантаження...</div>';
    db.collection("babak_crm_history").orderBy("timestamp", "desc").limit(30).get().then(snapshot => {
        if (snapshot.empty) {
            list.innerHTML = '<div style="padding: 10px; text-align: center; color: var(--c-texSec); font-size: 13px;">Історія збережень порожня</div>';
            return;
        }
        let html = '';
        snapshot.forEach(doc => {
            const data = doc.data();
            if(!data.timestamp) return;
            const date = data.timestamp.toDate();
            const dateStr = date.toLocaleString('uk-UA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
            
            html += `<div class="history-item">
                        <span class="history-date">${dateStr}</span>
                        <button class="history-restore-btn" onclick="restoreHistory('${doc.id}')">Відновити</button>
                     </div>`;
        });
        list.innerHTML = html || '<div style="padding: 10px; text-align: center; color: var(--c-texSec); font-size: 13px;">Історія порожня</div>';
    });
}
window.closeHistoryModal = function() { document.getElementById('historyModal').classList.remove('active'); }
window.restoreHistory = function(docId) {
    if (userRole !== 'admin') return;
    if(!confirm('Ви впевнені, що хочете повернутись до цієї версії? Всі поточні зміни будуть втрачені!')) return;
    
    db.collection("babak_crm_history").doc(docId).get().then(doc => {
        if (doc.exists) {
            const data = doc.data();
            pendingServerHtml = null; 
            
            db.collection("babak_crm").doc("main_state").set({
                html: data.html,
                menu: data.menu || menuData,
                templates: data.templates || rowTemplates,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                lastHistorySave: Date.now() 
            }, { merge: true }).then(() => {
                showToast("Таблицю успішно відновлено!");
                closeHistoryModal();
            });
        }
    });
}
function applyHtmlFromServer(newHtml) {
    const selectedIndices = Array.from(tbody.querySelectorAll('tr')).reduce((acc, tr, i) => {
        if(tr.classList.contains('selected')) acc.push(i);
        return acc;
    }, []);
    tbody.innerHTML = newHtml;
    const rows = tbody.querySelectorAll('tr');
    selectedIndices.forEach(i => {
        if (rows[i]) {
            rows[i].classList.add('selected');
            const cb = rows[i].querySelector('.row-checkbox');
            if (cb) { cb.checked = true; cb.setAttribute('checked', 'checked'); }
        }
    });
    updateActionButtons(); 
    applyFilters(); 
    updateTodayHighlights(); 
    updateAllUnreadDots();
    updateRowNumbers();
    if (typeof window._initRecipientCells === 'function') window._initRecipientCells();
    setTimeout(updateAllMaterialWarnings, 150);
}
function startCloudSync() {
    if (unsubscribe) unsubscribe();
    // Завантажуємо локальний кеш одразу — сторінка відображається миттєво
    try {
        const cachedMenu = localStorage.getItem('tabix_menu_cache');
        const cachedTemplates = localStorage.getItem('tabix_templates_cache');
        if (cachedMenu) {
            const parsed = JSON.parse(cachedMenu);
            menuData = { ...menuData, ...parsed };
            window._dataLoadedFromCloud = true; // показуємо таблицю одразу
        }
        if (cachedTemplates) {
            rowTemplates = JSON.parse(cachedTemplates);
        }
    } catch(e) {}
    // Таймаут — якщо за 6 секунд дані не прийшли, перезапускаємо
    const loadTimeout = setTimeout(() => {
        if (!window._freshDataFromCloud) {
            console.warn('Firebase timeout — retrying...');
            if (unsubscribe) { unsubscribe(); unsubscribe = null; }
            setTimeout(startCloudSync, 500);
        }
    }, 6000);
    unsubscribe = db.collection("babak_crm").doc("main_state").onSnapshot((doc) => {
        clearTimeout(loadTimeout);
        window._freshDataFromCloud = true;
        if (doc.exists) {
            const data = doc.data(); 
            if (data.menu) {
                menuData = { ...menuData, ...data.menu };
                if (!menuData.product) menuData.product = [];
                if (!menuData.size) menuData.size = [];
                if (!menuData.source) menuData.source = [];
            }
            // Статуси беремо З Firebase (там збережені кольори юзера)
            // Якщо Firebase порожній - використовуємо FIXED_STATUSES як fallback
            if (!menuData.status || menuData.status.length === 0) {
                menuData.status = FIXED_STATUSES;
            } else {
                // Тільки додаємо відсутні - не перезаписуємо кольори з Firebase
                FIXED_STATUSES.forEach(function(def) {
                    if (!menuData.status.find(function(s){ return s.text === def.text; })) {
                        menuData.status.push(def);
                    }
                });
            }
            window._dataLoadedFromCloud = true;
            rowTemplates = data.templates || rowTemplates;
            // Зберігаємо кеш локально
            try {
                localStorage.setItem('tabix_menu_cache', JSON.stringify(menuData));
                localStorage.setItem('tabix_templates_cache', JSON.stringify(rowTemplates));
            } catch(e) {}
            // Перерендеримо плашки в таблиці з правильними кольорами з Firebase
            setTimeout(() => {
                // Синхронізуємо фільтр зі статусами Firebase (зберігаємо логіку "без Відправлено")
                const allFirebaseStatuses = (menuData.status || [])
                    .filter(s => s.text !== 'Відправлено')
                    .map(s => s.text);
                activeFilters.status = activeFilters.status.filter(s => allFirebaseStatuses.includes(s));
                if (activeFilters.status.length === 0) {
                    activeFilters.status = allFirebaseStatuses;
                }
                if (typeof renderStatusFilters === 'function') renderStatusFilters();
                if (typeof applyFilters === 'function') applyFilters();
                document.querySelectorAll('#tableBody tr').forEach(row => {
                    ['source','product','status'].forEach(type => {
                        const cell = row.querySelector(`td[data-type="${type}"]`);
                        if (!cell) return;
                        const val = cell.dataset.val || cell.innerText.trim();
                        if (!val) return;
                        if (type === 'status') {
                            cell.innerHTML = getStatusHtml(val);
                        } else if (type === 'source') {
                            const item = menuData['source']?.find(s => s.text?.trim().toLowerCase() === val.trim().toLowerCase());
                            if (item) cell.innerHTML = `<div class="clamp-wrapper" style="align-items:center;display:flex;justify-content:center;height:100%;width:100%;"><span class="badge badge-status" style="${item.customStyle||''}">${item.text}</span></div>`;
                        } else if (type === 'product') {
                            cell.innerHTML = getProductHtml(val);
                        }
                    });
                });
            }, 100);
            if (data.html && !window._migratedToOrders) {
                db.collection("orders").limit(1).get().then(snap => {
                    if (snap.empty) {
                        const isInteracting = document.querySelector('.popover.active') !== null || document.querySelector('.modal-overlay.active') !== null;
                        if (!isInteracting) applyHtmlFromServer(data.html);
                    } else {
                        window._migratedToOrders = true;
                        const btn = document.getElementById('btnMigrate');
                        if (btn) btn.style.display = 'none';
                    }
                });
            }
        } else { 
            window._dataLoadedFromCloud = true;
            if(userRole === 'admin') { addRowFromTemplate(0, false); saveData(); } 
        }
    });
}
function saveData(skipUndo = false) {
    if (userRole !== 'admin' && userRole !== 'limited') return;
    pendingServerHtml = null; 
    pendingServerMenu = null;
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        if (window._migratedToOrders) {
            // Після міграції — тільки меню і шаблони, без HTML
            db.collection("babak_crm").doc("main_state").set({ 
                menu: menuData, 
                templates: rowTemplates, 
                updatedAt: firebase.firestore.FieldValue.serverTimestamp() 
            }, { merge: true }).catch(err => console.error(err));
        } else {
            // До міграції — зберігаємо HTML як раніше
            const tempDiv = document.createElement('tbody');
            tempDiv.innerHTML = tbody.innerHTML;
            tempDiv.querySelectorAll('tr.selected').forEach(tr => tr.classList.remove('selected'));
            tempDiv.querySelectorAll('input.row-checkbox').forEach(cb => {
                cb.checked = false; 
                cb.removeAttribute('checked');
            });
            db.collection("babak_crm").doc("main_state").set({ 
                html: tempDiv.innerHTML, 
                menu: menuData, 
                templates: rowTemplates, 
                updatedAt: firebase.firestore.FieldValue.serverTimestamp() 
            }, { merge: true }).catch(err => console.error(err));
        }
    }, 500);
}
function updateAllUnreadDots() {
    document.querySelectorAll('.comment-pin').forEach(pin => {
        let readBy = JSON.parse(pin.dataset.readby || '[]');
        const dot = pin.querySelector('.unread-dot');
        if (dot) { dot.style.display = readBy.includes(currentUser) ? 'none' : 'block'; }
    });
}
function renderTemplateMenuContent() {
    templateOptions.innerHTML = '';
    rowTemplates.forEach((tpl, idx) => {
        const delHtml = idx === 0 ? '' : `<div class="popover-actions"><span class="pop-action-icon delete" onclick="deleteRowTemplate(event, ${idx})" title="Видалити шаблон"><svg viewBox="0 0 16 16"><path d="M12.642 3.358a.625.625 0 0 0-.884 0L8 7.116 4.242 3.358a.625.625 0 1 0-.884.884L7.116 8l-3.758 3.758a.625.625 0 0 0 .884.884L8 8.884l3.758 3.758a.625.625 0 1 0 .884-.884L8.884 8l3.758-3.758a.625.625 0 1 0 .884-.884L8.884 8l3.758-3.758a.625.625 0 0 0 0-.884"></path></svg></span></div>`;
        templateOptions.innerHTML += `<div class="popover-item-wrap"><div class="popover-item" onclick="addRowFromTemplate(${idx})">${idx === 0 ? '📄 ' : '✨ '}${tpl.name}</div>${delHtml}</div>`;
    });
}
window.addRowFromTemplate = function(idx, shouldSave = true) {
    if(userRole === 'limited') return; 
    recordUndoState();
    const tpl = rowTemplates[idx]; const d = tpl.data || []; const row = document.createElement('tr');
    
    const dateVal = (d[2] || '').replace(' - ', '<br>');
    
    const getCellHtml = (content) => {
        if (!content) return '<div class="clamp-wrapper"></div>';
        if (content.includes('clamp-wrapper')) return content; 
        return `<div class="clamp-wrapper">${content}</div>`;
    };
    const getValAttr = (content) => {
        if (!content || content.includes('<div') || content.includes('<span')) return '';
        return `data-val="${content.replace(/"/g, '&quot;')}"`;
    };
    let statusHtml = d[10];
    let statusTextForHistory = '';
    
    if (!statusHtml) {
        let defaultStatus = menuData['status'].find(s => s.text === 'Нове');
        if (!defaultStatus) defaultStatus = menuData['status'][0] || { text: 'Нове', class: 'badge-status', customStyle: 'background-color: #e3e2e0; color: #37352f;' };
        
        statusHtml = `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;"><span class="badge ${defaultStatus.class || 'badge-status'}" style="${defaultStatus.customStyle}">${defaultStatus.text}</span></div>`;
        statusTextForHistory = defaultStatus.text;
    } else {
        let tempDiv = document.createElement('div');
        tempDiv.innerHTML = statusHtml;
        statusTextForHistory = tempDiv.innerText.trim();
    }
    const initialHistory = [{ s: statusTextForHistory, t: Date.now(), isCreation: true }];
    row.dataset.history = JSON.stringify(initialHistory);
    row.innerHTML = `
        <td class="cell-checkbox no-print"><span class="row-num"></span><input type="checkbox" class="row-checkbox"></td>
        <td class="select-cell" data-type="source">${d[1] || ''}</td>
        <td class="date-cell" data-type="date">${dateVal}</td>
        <td class="text-cell copyable-cell" data-type="name" ${getValAttr(d[3])}>${getCellHtml(d[3])}</td>
        <td class="select-cell" data-type="product">${d[4] || ''}</td>
        <td class="text-cell" data-type="pers" ${getValAttr(d[5])}>${getCellHtml(d[5])}</td>
        <td class="select-cell" data-type="color">${d[6] || ''}</td>
        <td class="select-cell" data-type="size">${d[7] || ''}</td>
        <td class="text-cell" data-type="design" ${getValAttr(d[8])}>${getCellHtml(d[8])}</td>
        <td class="text-cell copyable-cell" data-type="recipient" ${getValAttr(d[9])}>${getCellHtml(d[9])}</td>
        <td class="select-cell" data-type="status">${statusHtml}</td>
        <td class="text-cell copyable-cell" data-type="tracking" ${getValAttr(d[11])}>${getCellHtml(d[11])}</td>
        <td class="image-cell" data-type="layout">${d[12] || '<span class="img-placeholder">+ Додати</span>'}</td>`;
    
    const img = row.querySelector('.img-wrapper img');
    if (img) img.setAttribute('loading', 'lazy');
    if (window._migratedToOrders) {
        // Після міграції — не додаємо в DOM вручну, Firebase snapshot сам додасть
        hidePopover(newTemplateMenu);
        const existingRows = Array.from(tbody.querySelectorAll('tr[data-order-id]'));
        const maxSort = existingRows.reduce((max, r) => Math.max(max, parseInt(r.dataset.sortOrder||0)), 0);
        row.dataset.sortOrder = maxSort + 1;
        syncRowToDb(row);
    } else {
        tbody.prepend(row); hidePopover(newTemplateMenu); applyFilters(); updateTodayHighlights(); updateRowNumbers();
        saveData();
    }
}
window.openTemplateModal = function(btn) { hoveredRowForTemplate = btn.closest('tr'); modalInput.value = ''; customModal.classList.add('active'); setTimeout(() => modalInput.focus(), 100); }
window.closeModal = function() { customModal.classList.remove('active'); }
window.saveModalTemplate = function() {
    const tName = modalInput.value.trim(); if(!tName) return; const cells = hoveredRowForTemplate.querySelectorAll('td'); const rowData = []; cells.forEach(cell => rowData.push(cell.innerHTML));
    rowTemplates.push({ name: tName, data: rowData }); saveData(); renderTemplateMenuContent(); showToast(`Шаблон "${tName}" збережено`); closeModal();
}
modalInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') saveModalTemplate(); });
window.deleteRowTemplate = function(e, idx) { e.stopPropagation(); if(confirm(`Видалити шаблон "${rowTemplates[idx].name}"?`)) { rowTemplates.splice(idx, 1); saveData(); renderTemplateMenuContent(); } }
function updateTodayHighlights() {
    const today = new Date(); const m = String(today.getMonth() + 1).padStart(2, '0'); const d = String(today.getDate()).padStart(2, '0'); const todayStr = `${m}/${d}`;
    document.querySelectorAll('#tableBody tr').forEach(row => {
        const dateCell = row.querySelector('.date-cell'); const statusCell = row.querySelector('.select-cell[data-type="status"]'); const statusText = statusCell ? statusCell.innerText.trim().toLowerCase() : '';
        const isDone = statusText === 'done' || statusText === 'зроблено' || statusText === 'відправлено';
        let isDeadlineToday = false;
        if (dateCell && dateCell.innerHTML) {
            const parts = dateCell.innerHTML.split(/<br\s*[\/]?>/i);
            const deadline = parts.length > 1 ? parts[1].trim() : parts[0].trim();
            if (deadline === todayStr) { isDeadlineToday = true; }
        }
        if (isDeadlineToday && !isDone) { row.classList.add('highlight-today'); } else { row.classList.remove('highlight-today'); }
    });
}
const fp = flatpickr("#datePickerInput", { 
    mode: "range", dateFormat: "m/d", showMonths: 1, disableMobile: true, locale: { rangeSeparator: " - " }, 
    onClose: function(selectedDates, dateStr) { 
        if(currentEditingCell && currentEditingCell.classList.contains('date-cell')) { 
            recordUndoState();
            currentEditingCell.innerHTML = dateStr.replace(' - ', '<br>'); 
            updateTodayHighlights(); saveData();
            if (typeof syncRowToDb === 'function') {
                syncRowToDb(currentEditingCell.closest('tr'));
            }
        } 
    } 
});
function getUniqueValuesFromColumn(dataType) {
    const values = new Set();
    document.querySelectorAll('#tableBody tr').forEach(row => {
        const cell = row.querySelector(`td[data-type="${dataType}"]`);
        if (cell) {
            const badges = cell.querySelectorAll('.badge');
            if (badges.length > 0) {
                badges.forEach(b => {
                    let text = b.innerText.replace(/\n/g, ' ').trim();
                    if (text && text !== '?') values.add(text);
                });
            } else {
                let text = cell.innerText.replace(/\n/g, ' ').trim();
                if (text && text !== '?') values.add(text);
            }
        }
    });
    if (dataType === 'product' && menuData['product']) { menuData['product'].forEach(p => { if (p.text !== 'Очистити') values.add(p.text); }); }
    if (dataType === 'color') { window.kopilkaColors.forEach(c => values.add(c.name)); window.hwColors.forEach(c => values.add(c.name)); }
    if (dataType === 'size') { window.hwSizes.forEach(s => values.add(s)); if (menuData['size']) menuData['size'].forEach(s => { if (s.text !== 'Очистити') values.add(s.text); }); }
    if (dataType === 'design') { window.hwDesigns.forEach(d => values.add(d)); if (menuData['design']) menuData['design'].forEach(d => { if (d.text !== 'Очистити') values.add(d.text); }); ['A','B','C','D','E','F'].forEach(l => values.add(l)); }
    return Array.from(values).filter(Boolean).sort();
}
function renderStatusFilters() {
    const statusContainer = document.getElementById('f-status-container');
    statusContainer.innerHTML = '';
    if (menuData['status']) {
        menuData['status'].filter(s => s.text !== 'Очистити').forEach(s => {
            const isActive = activeFilters.status.includes(s.text);
            let bg = '#e3e2e0';
            let col = '#37352f';
            
            if (s.customStyle) {
                s.customStyle.split(';').forEach(rule => {
                    let parts = rule.split(':');
                    if(parts.length === 2) {
                        let k = parts[0].trim().toLowerCase();
                        let v = parts[1].trim();
                        if(k === 'background-color') bg = v;
                        if(k === 'color') col = v;
                    }
                });
            }
            
            const borderStyle = isActive ? `border: 1px solid ${col};` : `border: 1px solid rgba(0,0,0,0.15);`;
            let activeStyle = isActive ? `opacity: 1; font-weight: 600;` : `opacity: 0.8;`;
            let icon = isActive ? `<svg class="f-clear-icon" style="fill: ${col}; margin-left: 6px; width: 12px; height: 12px;" viewBox="0 0 16 16"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>` : '';
            statusContainer.innerHTML += `<div class="f-tag status-tag" style="background-color: ${bg}; color: ${col}; ${borderStyle} ${activeStyle} transition: 0.15s ease;" onclick="togglePuzzleFilter('status', '${s.text.replace(/'/g, "\\'")}')"><span style="color: ${col};">${s.text}</span>${icon}</div>`;
        });
    }
}
window.openPuzzleFilter = function(e, button) {
    e.stopPropagation();
    closeAllPopovers();
    renderStatusFilters();
    renderAdvancedCategory('product', 'f-product-container');
    renderAdvancedCategory('color', 'f-color-container');
    renderAdvancedCategory('size', 'f-size-container');
    renderAdvancedCategory('design', 'f-design-container');
    const filterMenu = document.getElementById('filterMenu');
    window.smartPosition(filterMenu, button.getBoundingClientRect(), 'bottom');
}
function renderAdvancedCategory(type, containerId) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    const values = getUniqueValuesFromColumn(type);
    
    if (values.length === 0) {
        container.innerHTML = '<span style="color:var(--c-texTer); font-size:12px;">Немає даних</span>';
        return;
    }
    values.forEach(val => {
        const isActive = activeFilters[type].includes(val);
        const activeClass = isActive ? 'selected' : ''; 
        let icon = isActive ? `<svg class="f-clear-icon" viewBox="0 0 16 16"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>` : '';
        
        let innerHTML = val;
        if (type === 'color') {
            let colorObj = window.kopilkaColors.find(c => c.name === val) || window.hwColors.find(c => c.name === val) || (window.wtColors||[]).find(c => c.name === val);
            if (colorObj) {
                innerHTML = `<span style="display:inline-block; min-width:10px; width:10px; height:10px; background-color:${colorObj.hex}; border:1px solid rgba(0,0,0,0.15); border-radius:50%; margin-right:6px; flex-shrink:0;"></span>${val}`;
            }
        }
        container.innerHTML += `<div class="f-tag regular-tag ${activeClass}" onclick="togglePuzzleFilter('${type}', '${val.replace(/'/g, "\\'")}')"><span>${innerHTML}</span>${icon}</div>`;
    });
}
window.toggleAdvancedFilters = function(btn) {
    const wrap = document.getElementById('advancedFiltersWrap');
    if (wrap.classList.contains('active')) {
        wrap.classList.remove('active');
        btn.classList.remove('open');
    } else {
        wrap.classList.add('active');
        btn.classList.add('open');
    }
}
window.togglePuzzleFilter = function(category, value) {
    const index = activeFilters[category].indexOf(value);
    if (index === -1) { activeFilters[category].push(value); } 
    else { activeFilters[category].splice(index, 1); }
    
    if(category === 'status') { renderStatusFilters(); } else { renderAdvancedCategory(category, `f-${category}-container`); }
    applyFilters();
}
window.resetAllFilters = function() {
    activeFilters = { status: [], product: [], color: [], size: [], design: [] };
    currentSearchQuery = ''; document.getElementById('searchInput').value = '';
    
    const openBtn = document.getElementById('filterBtnIcon');
    if(document.getElementById('filterMenu').classList.contains('active')){
        openPuzzleFilter({stopPropagation:()=>{}}, openBtn); 
    }
    applyFilters();
}
searchInput.addEventListener('input', (e) => { currentSearchQuery = e.target.value.toLowerCase(); applyFilters(); });
function applyFilters() {
    let isActiveFilterPresent = false;
    let visibleCount = 0; // Счетчик заказов, которые прошли фильтр
    
    document.querySelectorAll('#tableBody tr').forEach(row => {
        let rowPasses = true;
        for (const category in activeFilters) {
            if (activeFilters[category].length > 0) {
                isActiveFilterPresent = true;
                const cell = row.querySelector(`td[data-type="${category}"]`);
                if (!cell) { rowPasses = false; break; }
                
                let cellVals = [];
                const badges = cell.querySelectorAll('.badge');
                if (badges.length > 0) {
                    cellVals = Array.from(badges).map(b => b.innerText.replace(/\n/g, ' ').trim());
                } else {
                    cellVals = [cell.innerText.replace(/\n/g, ' ').trim()];
                }
                const categoryMatch = activeFilters[category].some(filterVal => cellVals.includes(filterVal));
                if (!categoryMatch) { rowPasses = false; break; }
            }
        }
        if (rowPasses && currentSearchQuery !== '') {
            const nameText = row.children[3].innerText.toLowerCase(); 
            const recipientText = row.children[9].innerText.toLowerCase(); 
            const trackingText = row.children[11].innerText.toLowerCase();
            if (!nameText.includes(currentSearchQuery) && !recipientText.includes(currentSearchQuery) && !trackingText.includes(currentSearchQuery)) {
                rowPasses = false;
            }
        }
        // ПАГИНАЦИЯ: Проверяем, влезает ли заказ в лимит (20, 40, 60...)
        if (rowPasses) {
            if (visibleCount < displayLimit) {
                row.style.display = '';
                row.classList.remove('hidden-by-pagination');
            } else {
                row.style.display = 'none'; // Прячем старые
                row.classList.add('hidden-by-pagination');
            }
            visibleCount++;
        } else {
            row.style.display = 'none';
            row.classList.remove('hidden-by-pagination');
        }
    }); 
    
    const filterBtn = document.getElementById('filterBtnIcon');
    if (isActiveFilterPresent || currentSearchQuery !== '') {
        filterBtn.classList.remove('btn-icon-faded');
        filterBtn.classList.add('active-filter-icon');
    } else {
        filterBtn.classList.add('btn-icon-faded');
        filterBtn.classList.remove('active-filter-icon');
    }
    
    // Управление кнопкой "Показать еще"
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    if (loadMoreBtn) {
        if (visibleCount > displayLimit) {
            loadMoreBtn.style.display = 'inline-block';
            loadMoreBtn.innerText = 'Показати ще 20';
        } else {
            loadMoreBtn.style.display = 'none';
        }
    }
    
    updateRowNumbers();
}
// ДОБАВЛЯЕМ ФУНКЦИЮ ДЛЯ КНОПКИ
window.loadMoreOrders = function() {
    displayLimit += 20; // Увеличиваем лимит
    applyFilters();     // Перерисовываем таблицу
};
const imageInput = document.createElement('input'); imageInput.type = 'file'; imageInput.accept = 'image/*'; imageInput.style.display = 'none'; document.body.appendChild(imageInput);
imageInput.addEventListener('change', function(e) {
    const file = e.target.files[0]; if (!file) return; const reader = new FileReader();
    reader.onload = function(event) {
        const img = new Image(); img.onload = function() {
            const canvas = document.createElement('canvas'); const MAX_WIDTH = 800; const MAX_HEIGHT = 800; let width = img.width; let height = img.height;
            if (width > height) { if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; } } else { if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; } }
            canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height); const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            if(currentEditingCell) {
                recordUndoState();
                const _delBtn1 = currentUser === 'матвій' ? `<button class="img-btn delete-btn" title="Видалити"><svg viewBox="0 0 16 16"><path d="M3.2 4.8h9.6l-.8 8.8c-.1.8-.8 1.6-1.6 1.6H5.6c-.8 0-1.5-.8-1.6-1.6l-.8-8.8zm2.4 8h1.6V6.4H5.6V12.8zm3.2 0h1.6V6.4H8.8V12.8zM4.8 3.2V1.6C4.8.7 5.5 0 6.4 0h3.2c.9 0 1.6.7 1.6 1.6v1.6h3.2v1.6H1.6V3.2h3.2zM6.4 1.6v1.6h3.2V1.6H6.4z"></path></svg></button>` : '';
                currentEditingCell.innerHTML = `<div class="img-cell-wrap"><div class="img-wrapper"><img src="${dataUrl}" loading="lazy"><div class="img-actions no-print"><button class="img-btn view-btn" title="Переглянути"><svg viewBox="0 0 16 16"><path d="M2 2v4h1.5V3.5H7V2H2zm12 0h-5v1.5h3.5V7H14V2zM2 14h5v-1.5H3.5V9H2v5zm12 0V9h-1.5v3.5H9V14h5z"></path></svg></button>${_delBtn1}</div></div><button class="img-dl-btn no-print" title="Завантажити макет" onclick="downloadLayout(this)"><svg viewBox="0 0 16 16"><path d="M8 11.5l-4.5-4.5h3V2h3v5h3L8 11.5zM2 13.5v1h12v-1H2z"/></svg></button></div>`; saveData();
            } imageInput.value = ''; 
        }; img.src = event.target.result;
    }; reader.readAsDataURL(file);
});
// --- ВИТЯГАННЯ ЧЕКБОКСІВ (Окремо) ---
let isCheckboxDragging = false;
tbody.addEventListener('mousedown', (e) => { 
    if(e.target.closest('.mat-warn-left')) return; // не спрацьовуємо на іконках матеріалів
    if(e.target.closest('.cell-checkbox')) { isCheckboxDragging = true; toggleRowSelection(e.target.closest('tr')); } 
});
tbody.addEventListener('mouseover', (e) => { if(isCheckboxDragging && e.target.closest('.cell-checkbox')) { toggleRowSelection(e.target.closest('tr')); } });
document.addEventListener('mouseup', () => { if(isCheckboxDragging) { isCheckboxDragging = false; updateActionButtons(); saveData(); } });
// --- MARQUEE SELECTION (Виділення мишкою) ---
let isMarqueeDragging = false; let marqueeStartX = 0; let marqueeStartY = 0; let marqueeDragDistance = 0;
const selectionBox = document.createElement('div'); selectionBox.id = 'selectionBox'; document.body.appendChild(selectionBox);
document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    
    // Вимикаємо рамку на всіх вкладках крім замовлень
    const materialsView = document.getElementById('materialsView');
    if (materialsView && materialsView.offsetParent !== null) return;
    const productsView = document.getElementById('productsView');
    if (productsView && productsView.offsetParent !== null) return;
    const shippingView = document.getElementById('shippingView');
    if (shippingView && shippingView.offsetParent !== null) return;
    const wbView = document.getElementById('wbView');
    if (wbView && wbView.offsetParent !== null) return;
    const financesView = document.getElementById('financesView');
    if (financesView && financesView.offsetParent !== null) return;
    // Якщо клікнули по таблиці (не по чекбоксу) — не запускаємо рамку
    if (e.target.closest('td') && !e.target.closest('.cell-checkbox')) return;
    if (e.target.closest('.popover') || e.target.closest('.modal-overlay') || e.target.closest('button') || e.target.closest('input') || e.target.closest('textarea') || e.target.closest('select') || e.target.closest('label') || e.target.closest('.user-profile-btn') || e.target.closest('.chat-header')) return;
    document.body.classList.add('no-select'); 
    isMarqueeDragging = true; marqueeStartX = e.clientX; marqueeStartY = e.clientY; marqueeDragDistance = 0;
    selectionBox.style.left = marqueeStartX + 'px'; selectionBox.style.top = marqueeStartY + 'px'; selectionBox.style.width = '0px'; selectionBox.style.height = '0px';
});
document.addEventListener('mousemove', (e) => {
    if (!isMarqueeDragging) return;
    const width = Math.abs(e.clientX - marqueeStartX); const height = Math.abs(e.clientY - marqueeStartY); marqueeDragDistance = Math.max(width, height);
    if (marqueeDragDistance > 10) {
        selectionBox.style.display = 'block';
        const left = Math.min(marqueeStartX, e.clientX); const top = Math.min(marqueeStartY, e.clientY);
        selectionBox.style.left = left + 'px'; selectionBox.style.top = top + 'px'; selectionBox.style.width = width + 'px'; selectionBox.style.height = height + 'px';
        const marqueeRect = selectionBox.getBoundingClientRect();
        document.querySelectorAll('#tableBody tr').forEach(tr => {
            if(tr.style.display === 'none') return;
            const trRect = tr.getBoundingClientRect();
            const isIntersecting = !(trRect.right < marqueeRect.left || trRect.left > marqueeRect.right || trRect.bottom < marqueeRect.top || trRect.top > marqueeRect.bottom);
            const checkbox = tr.querySelector('.row-checkbox');
            if (isIntersecting) { tr.classList.add('selected'); if (checkbox) { checkbox.checked = true; checkbox.setAttribute('checked', 'checked'); } } else { tr.classList.remove('selected'); if (checkbox) { checkbox.checked = false; checkbox.removeAttribute('checked'); } }
        });
        updateActionButtons();
    }
});
document.addEventListener('mouseup', (e) => {
    document.body.classList.remove('no-select'); 
    if (isMarqueeDragging) { isMarqueeDragging = false; selectionBox.style.display = 'none'; if (marqueeDragDistance > 10) { saveData(); } }
});
function toggleRowSelection(tr) {
    const checkbox = tr.querySelector('.row-checkbox');
    if(tr.classList.contains('selected')) { tr.classList.remove('selected'); checkbox.checked = false; checkbox.removeAttribute('checked'); } else { tr.classList.add('selected'); checkbox.checked = true; checkbox.setAttribute('checked', 'checked'); }
    updateActionButtons();
}
function updateActionButtons() { if (userRole !== 'admin') { btnDelete.style.display = 'none'; return; } btnDelete.style.display = document.querySelectorAll('.selected').length > 0 ? 'flex' : 'none'; }
window.deleteSelected = function() { 
    if (userRole !== 'admin') { 
        alert("У вас немає прав для видалення рядків."); 
        return; 
    }
    
    const tbody = document.getElementById('tableBody');
    const selectedRows = tbody.querySelectorAll('.selected'); 
    if (selectedRows.length === 0) return;
    if(confirm(`Видалити обрані рядки (${selectedRows.length}) назавжди?`)) { 
        if (typeof recordUndoState === 'function') recordUndoState(); 
        
        selectedRows.forEach(row => {
            const orderId = row.dataset.orderId;
            // 1. Моментально удаляем из базы Make
            if (orderId && typeof db !== 'undefined') {
                db.collection("orders").doc(orderId).delete().catch(e => console.error(e));
            }
            // 2. Убираем с экрана
            row.remove(); 
        }); 
        
        if (typeof updateActionButtons === 'function') updateActionButtons(); 
        if (typeof updateTodayHighlights === 'function') updateTodayHighlights(); 
        if (typeof updateRowNumbers === 'function') updateRowNumbers(); 
        
        // 3. ПРИНУДИТЕЛЬНОЕ СОХРАНЕНИЕ БЕЗ ЗАДЕРЖЕК
        // Отменяем стандартное 500мс ожидание, чтобы никто не перебил сохранение
        if (typeof saveTimeout !== 'undefined' && saveTimeout) {
            clearTimeout(saveTimeout);
        }
        
        const tempDiv = document.createElement('tbody');
        tempDiv.innerHTML = tbody.innerHTML;
        
        tempDiv.querySelectorAll('tr.selected').forEach(tr => tr.classList.remove('selected'));
        tempDiv.querySelectorAll('input.row-checkbox').forEach(cb => {
            cb.checked = false; 
            cb.removeAttribute('checked');
        });
        // Жестко и сразу отправляем новый вид таблицы в базу
        if (typeof db !== 'undefined') {
            db.collection("babak_crm").doc("main_state").set({ 
                html: tempDiv.innerHTML, 
                menu: typeof menuData !== 'undefined' ? menuData : {}, 
                templates: typeof rowTemplates !== 'undefined' ? rowTemplates : [], 
                updatedAt: firebase.firestore.FieldValue.serverTimestamp() 
            }, { merge: true });
        }
    } 
}
window.openLightbox = function(src) { lightboxImg.src = src; lightbox.classList.add('active'); }
window.closeLightbox = function() { lightbox.classList.remove('active'); lightboxImg.src = ''; }
window.downloadLayout = async function(btn) {
    const selectedRows = Array.from(document.querySelectorAll('#tableBody tr.selected'));
    // Якщо виділено більше одного рядка — качаємо кожен dxf окремо з затримкою
    if (selectedRows.length > 1) {
        const rowsWithDxf = selectedRows.map((row, idx) => {
            const wrap = row.querySelector('.img-cell-wrap');
            const dxfUrl = wrap?.dataset?.dxf || '';
            if (!dxfUrl) return null;
            const name = (row.querySelector('td[data-type="name"]')?.innerText?.trim() || `макет_${idx+1}`).replace(/[^\wа-яА-ЯіІєЄїЇ\s\-]/g, '').trim();
            const pers = row.querySelector('td[data-type="pers"]')?.innerText?.trim() || '';
            const fileName = pers ? `${name} — ${pers}` : name;
            const urlPath = dxfUrl.split('?')[0];
            const ext = urlPath.includes('.') ? urlPath.split('.').pop().toLowerCase() : 'dxf';
            return { dxfUrl, fileName: `${fileName}.${ext}` };
        }).filter(Boolean);
        if (rowsWithDxf.length === 0) {
            showToast('⚠️ У виділених рядках немає dxf проектів');
            return;
        }
        showToast(`⏳ Завантажуємо ${rowsWithDxf.length} файлів...`);
        // Скачуємо по одному з затримкою 400мс — браузер не блокує
        for (let i = 0; i < rowsWithDxf.length; i++) {
            const { dxfUrl, fileName } = rowsWithDxf[i];
            const a = document.createElement('a');
            a.href = dxfUrl;
            a.download = fileName;
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (i < rowsWithDxf.length - 1) {
                await new Promise(r => setTimeout(r, 400));
            }
        }
        showToast(`✅ Запущено завантаження ${rowsWithDxf.length} файлів`);
        return;
    }
    // Одиночне завантаження
    const wrap = btn?.closest('.img-cell-wrap');
    if (!wrap) return;
    const dxfUrl = wrap.dataset.dxf;
    if (dxfUrl) {
        const a = document.createElement('a');
        a.href = dxfUrl;
        a.download = '';
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } else {
        const img = wrap.querySelector('img');
        if (!img) return;
        const a = document.createElement('a');
        a.href = img.src;
        a.download = 'макет.jpg';
        a.click();
    }
};
window.showPopover = function(element, rect) { window.smartPosition(element, rect, 'bottom'); }
cellInput.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeAllPopovers(); } });
cellInput.addEventListener('input', function() { this.style.height = 'auto'; this.style.height = (this.scrollHeight) + 'px'; textInputPopover.style.height = 'auto'; });
function showToast(msg) { toastMsg.querySelector('.toast-text').innerText = msg; toastMsg.classList.add('show'); setTimeout(() => toastMsg.classList.remove('show'), 2500); }
document.addEventListener('mousemove', (e) => {
    if (isMarqueeDragging) return; 
    const cell = e.target.closest('.copyable-cell'); const btnCopy = e.target.closest('#globalCopyBtn');
    if (cell && cell.innerText.trim() !== '') { hoveredCopyCell = cell; const rect = cell.getBoundingClientRect(); globalCopyBtn.style.top = `${rect.top + 5}px`; globalCopyBtn.style.left = `${rect.right - 30}px`; globalCopyBtn.style.display = 'flex'; } else if (!btnCopy) { globalCopyBtn.style.display = 'none'; hoveredCopyCell = null; }
});
globalCopyBtn.addEventListener('click', (e) => {
    e.stopPropagation(); 
    if(hoveredCopyCell) { let textToCopy = hoveredCopyCell.dataset.val !== undefined ? hoveredCopyCell.dataset.val : hoveredCopyCell.innerText.trim(); navigator.clipboard.writeText(textToCopy).then(() => { showToast('Вміст успішно скопійовано'); globalCopyBtn.style.display = 'none'; }); }
});
tbody.addEventListener('click', (e) => {
    const pin = e.target.closest('.comment-pin');
    if (pin) { e.stopPropagation(); openChatPopover(pin, e.clientX, e.clientY); return; }
    const viewBtn = e.target.closest('.view-btn'); if (viewBtn) { e.stopPropagation(); openLightbox(viewBtn.closest('.img-wrapper').querySelector('img').src); return; }
    const deleteImgBtn = e.target.closest('.delete-btn'); 
    if (deleteImgBtn) { if (userRole === 'limited') return; e.stopPropagation(); recordUndoState(); deleteImgBtn.closest('.image-cell').innerHTML = '<span class="img-placeholder">+ Додати</span>'; saveData(); return; }
    
    const td = e.target.closest('td'); if(!td || td.classList.contains('cell-checkbox') || td.classList.contains('no-print')) return; e.stopPropagation();
    if(td.classList.contains('select-cell') || td.classList.contains('text-cell')) {
        const rect = td.getBoundingClientRect(); 
        const row = td.closest('tr');
        const type = td.getAttribute('data-type');
        // Клік на клітинку отримувача — просте текстове поле (без модалу)
        if (type === 'recipient' && userRole !== 'limited') {
            closeAllPopovers();
            currentEditingCell = td;
            const currentVal = td.dataset.val || td.innerText.trim();
            cellInput.value = currentVal;
            cellInput.rows = 6;
            cellInput.style.width = '260px';
            cellInput.style.fontSize = '12px';
            cellInput.style.lineHeight = '1.7';
            cellInput.style.padding = '10px 12px';
            textInputPopover.style.width = '280px';
            textInputPopover.style.padding = '6px';
            const rect = td.getBoundingClientRect();
            window.smartPosition(textInputPopover, rect, 'side');
            cellInput.focus();
            return;
        }
        // Статус — тільки матвій може редагувати
        if (type === 'status' && currentUser !== 'матвій') return;
        const productText = row.children[4].innerText.toLowerCase();
        const isKopilka = productText.includes('копілк');
        const isHotwheels = productText.includes('хотвілс') || productText.includes('hotwheels') || productText.includes('hot wheels');
        const isWishTree = productText.includes('wish tree') || productText.includes('віш трі');
        if (isKopilka && type === 'pers') { closeAllPopovers(); currentEditingCell = td; window.openPersPopover(td, rect); return; } 
        else if (isKopilka && type === 'color') { closeAllPopovers(); currentEditingCell = td; window.openKopilkaColorPopover(td, rect, row); return; } 
        else if (isKopilka && type === 'size') { closeAllPopovers(); currentEditingCell = td; window.openKopilkaSizePopover(td, rect, row); return; } 
        else if (isKopilka && type === 'design') { closeAllPopovers(); currentEditingCell = td; window.openKopilkaDesignPopover(td, rect, row); return; } 
        else if (isHotwheels && type === 'pers') { closeAllPopovers(); currentEditingCell = td; window.openHwPersPopover(td, rect); return; } 
        else if (isHotwheels && type === 'color') { closeAllPopovers(); currentEditingCell = td; window.openHwColorPopover(td, rect); return; } 
        else if (isHotwheels && type === 'size') { closeAllPopovers(); currentEditingCell = td; window.openHwSizePopover(td, rect); return; } 
        else if (isHotwheels && type === 'design') { closeAllPopovers(); currentEditingCell = td; window.openHwDesignPopover(td, rect); return; }
        else if (isWishTree && type === 'pers')   { closeAllPopovers(); currentEditingCell = td; window.openWtPersPopover(td, rect); return; }
        else if (isWishTree && type === 'color')  { closeAllPopovers(); currentEditingCell = td; window.openWtColorPopover(td, rect); return; }
        else if (isWishTree && type === 'size')   { closeAllPopovers(); currentEditingCell = td; window.openWtSizePopover(td, rect); return; }
        else if (isWishTree && type === 'design') { return; } // дизайн — нічого
        if (td.classList.contains('select-cell')) {
            closeAllPopovers(); currentEditingCell = td; dropdownOptions.innerHTML = '';
            if (!menuData[type]) menuData[type] = [];
            menuData[type].forEach((item, idx) => {
                let displayText = type === 'design' ? item.text.replace(' ', '<br>') : item.text;
                const styleStr = item.customStyle ? `style="${item.customStyle}"` : ''; const badgeHtml = item.class ? `<span class="badge ${item.class}" ${styleStr} ${type === 'design' ? 'style="white-space:normal !important; text-align:center; height:auto; min-height:24px; line-height:1.1; padding:4px 8px;"' : ''}>${displayText}</span>` : `<span style="color:#999">${item.text}</span>`;
                // Для статусів — без кнопок редагування і видалення (статуси фіксовані)
                let actionsHtml = ''; if(item.text !== 'Очистити' && userRole === 'admin' && type !== 'product' && type !== 'status') { actionsHtml = `<div class="popover-actions"><span class="pop-action-icon" onclick="editStatus(event, ${idx}, '${type}')" title="Редагувати"><svg viewBox="0 0 16 16"><path d="M12.854 1.146a.5.5 0 0 0-.707 0L10.5 2.793 13.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708l-2-2zm-2.854.354L2.5 9V12h3l7.5-7.5-3-3z"/></svg></span><span class="pop-action-icon delete" onclick="deleteStatus(event, ${idx}, '${type}')" title="Видалити"><svg viewBox="0 0 16 16"><path d="M12.642 3.358a.625.625 0 0 0-.884 0L8 7.116 4.242 3.358a.625.625 0 1 0-.884.884L7.116 8l-3.758 3.758a.625.625 0 0 0 .884.884L8 8.884l3.758 3.758a.625.625 0 1 0 .884-.884L8.884 8l3.758-3.758a.625.625 0 1 0 .884-.884L8.884 8l3.758-3.758a.625.625 0 0 0 0-.884"></path></svg></span></div>`; }
                dropdownOptions.innerHTML += `<div class="popover-item-wrap" id="status-wrap-${idx}"><div class="popover-item" onclick="selectStatusValue(event, '${type}', '${item.text.replace(/'/g, "\\'")}')">${badgeHtml}</div>${actionsHtml}</div>`;
            });
            // Для статусів — без кнопки "Додати новий"
            if (userRole === 'admin' && type !== 'product' && type !== 'status') {
                dropdownOptions.innerHTML += `<div class="popover-divider"></div>`; 
                const inputWrapper = document.createElement('div'); inputWrapper.className = 'add-status-wrapper'; inputWrapper.id = 'active-add-wrapper';
                let addHtml = `<div style="display:flex; gap:6px; margin-bottom:4px;"><input type="text" class="add-status-input" placeholder="Новий варіант..." style="flex-grow:1;"><button class="add-status-btn" onclick="addNewVariant('${type}')">Додати</button></div>`;
                if (type !== 'size' && type !== 'color' && type !== 'design' && type !== 'product' && type !== 'source') {
                    let paletteHtml = colorPresets.map((c, i) => `<div class="color-circle" style="background:${c.bg}; border:1px solid ${c.border || c.color + '30'}" title="Вибрати колір" data-idx="${i}"></div>`).join('');
                    addHtml += `<div class="color-palette">${paletteHtml}</div>`;
                }
                inputWrapper.innerHTML = addHtml;
                const statusInput = inputWrapper.querySelector('input'); inputWrapper.onclick = (e) => e.stopPropagation();
                statusInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); window.addNewVariant(type); } };
                if (type !== 'size' && type !== 'color' && type !== 'design' && type !== 'product' && type !== 'source') {
                    const circles = inputWrapper.querySelectorAll('.color-circle');
                    circles.forEach(circle => { circle.onclick = (e) => { e.stopPropagation(); window.addNewVariant(type, circle.getAttribute('data-idx')); }; });
                }
                dropdownOptions.appendChild(inputWrapper);
            }
            if (!menuData[type].find(s => s.text === 'Очистити')) { dropdownOptions.innerHTML += `<div class="popover-item-wrap" style="margin-top:4px;"><div class="popover-item" onclick="selectStatusValue(event, '${type}', 'Очистити')"><span style="color:#999">Очистити</span></div></div>`; }
            window.smartPosition(dropdownMenu, td.getBoundingClientRect(), 'bottom');
        } else {
            if (userRole === 'limited') return; 
            closeAllPopovers(); currentEditingCell = td;
            textInputPopover.style.width = `${rect.width + 2}px`;
            
            let rawHtml = td.querySelector('.clamp-wrapper') ? td.querySelector('.clamp-wrapper').innerHTML : td.innerHTML;
            let extractedText = rawHtml.replace(/<br\s*[\/]?>/gi, '\n').replace(/<[^>]*>?/gm, '').trim();
            let cellVal = td.dataset.val;
            if (cellVal && !cellVal.includes('<div') && !cellVal.includes('<span')) { cellInput.value = cellVal; } 
            else { cellInput.value = extractedText; }
            
            window.smartPosition(textInputPopover, rect, 'over');
            cellInput.readOnly = false; cellInput.style.height = 'auto'; cellInput.style.height = Math.max(rect.height, cellInput.scrollHeight) + 'px'; cellInput.focus();
        }
    } else if(td.classList.contains('date-cell')) {
        closeAllPopovers();
        currentEditingCell = td; const dpInput = document.getElementById('datePickerInput'); dpInput.style.top = `${td.getBoundingClientRect().bottom + window.scrollY}px`; dpInput.style.left = `${td.getBoundingClientRect().left + window.scrollX}px`; 
        let dVal = td.innerHTML.replace(/<br\s*[\/]?>/gi, ' - ');
        if (dVal.trim()) { fp.setDate(dVal.split(' - ')); } else { fp.clear(); } fp.open();
    } else if (td.classList.contains('image-cell')) { if (!td.querySelector('.img-wrapper')) { currentEditingCell = td; imageInput.click(); } }
});
window.selectStatusValue = function(e, type, text) {
    e.stopPropagation(); 
    let historyText = text;
    if(text === 'Очистити') { 
        applyToCells(type, ''); 
        historyText = 'Очищено';
    } else { 
        const item = menuData[type].find(s => s.text === text); 
        const styleStr = item.customStyle ? `style="${item.customStyle}"` : ''; 
        let displayText = type === 'design' ? item.text.replace(' ', '<br>') : item.text;
        let newValue = `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;"><span class="badge ${item.class}" ${styleStr} ${type === 'design' ? 'style="white-space:normal !important; text-align:center; height:auto; min-height:24px; line-height:1.1; padding:4px 8px;"' : ''}>${displayText}</span></div>`; 
        applyToCells(type, newValue, item.text); 
    }
    if (type === 'status') {
        const addHistory = (cell) => {
            const row = cell.closest('tr');
            let history = [];
            try { history = JSON.parse(row.dataset.history || '[]'); } catch(err){}
            if (history.length === 0 || history[history.length - 1].s !== historyText) {
                history.push({ s: historyText, t: Date.now() });
                row.dataset.history = JSON.stringify(history);
            }
        };
        if (currentEditingCell.parentElement.classList.contains('selected')) {
            document.querySelectorAll('.selected').forEach(row => { let targetCell = row.querySelector(`td[data-type="${type}"]`); if (targetCell) addHistory(targetCell); });
        } else { addHistory(currentEditingCell); }
    }
    hidePopover(dropdownMenu); applyFilters(); updateTodayHighlights(); updateRowNumbers(); saveData();
}
window.showNewMenu = function(e, button) { e.stopPropagation(); renderTemplateMenuContent(); window.smartPosition(newTemplateMenu, button.getBoundingClientRect(), 'bottom'); }
window.addNewVariant = function(type, cIdx = 0) {
    const wrap = document.getElementById('active-add-wrapper'); const statusInput = wrap.querySelector('.add-status-input'); const newStatus = statusInput.value.trim(); 
    if (!newStatus) { statusInput.focus(); return; } 
    if(!menuData[type]) menuData[type] = [];
    if(!menuData[type].find(s => s.text === newStatus)) { 
        let randColor = colorPresets[cIdx] || colorPresets[0]; 
        let borderStyle = randColor.border ? `border: 1px solid ${randColor.border};` : 'border: 1px solid transparent;';
        if(type === 'size' || type === 'color' || type === 'design' || type === 'product' || type === 'source') { randColor = {bg: '#ffffff', color: '#37352f'}; borderStyle = 'border: 1px solid #d1d1d1;'; }
        const newItem = { text: newStatus, class: 'badge-status', customStyle: `background-color: ${randColor.bg}; color: ${randColor.color}; ${borderStyle}`, rawColor: randColor.color, isBase: false }; 
        const clearIdx = menuData[type].findIndex(s => s.text === 'Очистити'); 
        if (clearIdx !== -1) { menuData[type].splice(clearIdx, 0, newItem); } else { menuData[type].push(newItem); } 
        let displayText = type === 'design' ? newItem.text.replace(' ', '<br>') : newItem.text;
        let newValue = `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;"><span class="badge badge-status" style="${newItem.customStyle} ${type === 'design' ? 'white-space:normal !important; text-align:center; height:auto; min-height:24px; line-height:1.1; padding:4px 8px;"' : ''}">${displayText}</span></div>`; 
        applyToCells(type, newValue, newItem.text); hidePopover(dropdownMenu); 
        if (document.getElementById('filterMenu').classList.contains('active')) { const openBtn = document.getElementById('filterBtnIcon'); openPuzzleFilter({stopPropagation:()=>{}}, openBtn); }
        applyFilters(); updateTodayHighlights(); saveData(); 
    }
}
window.editStatus = function(e, idx, type) {
    e.stopPropagation(); const wrap = document.getElementById(`status-wrap-${idx}`); const item = menuData[type][idx];
    let addHtml = `<div style="display:flex; flex-direction:column; width:100%; padding:4px;"><div style="display:flex; gap:6px; margin-bottom:6px;"><input type="text" id="edit-status-input-${idx}" value="${item.text.replace(/"/g, '&quot;')}" class="add-status-input" style="flex-grow:1;"><button class="add-status-btn" onclick="saveEditedStatus(${idx}, '${type}', -1, event)">Зберегти</button></div>`;
    if (type !== 'size' && type !== 'color' && type !== 'design' && type !== 'product' && type !== 'source') {
        let paletteHtml = colorPresets.map((c, i) => `<div class="color-circle" style="background:${c.bg}; border:1px solid ${c.border || c.color + '30'}" title="Вибрати колір" onclick="saveEditedStatus(${idx}, '${type}', ${i}, event)"></div>`).join('');
        addHtml += `<div class="color-palette">${paletteHtml}</div>`;
    }
    addHtml += `</div>`;
    wrap.innerHTML = addHtml;
    const inp = document.getElementById(`edit-status-input-${idx}`); inp.focus(); inp.onclick = (ev) => ev.stopPropagation(); inp.onkeydown = (ev) => { if(ev.key === 'Enter') saveEditedStatus(idx, type, -1, ev); };
}
window.saveEditedStatus = function(idx, type, colorIdx, e) {
    e.stopPropagation(); e.preventDefault(); const inp = document.getElementById(`edit-status-input-${idx}`); const newText = inp.value.trim(); if(!newText) return;
    recordUndoState();
    const oldText = menuData[type][idx].text; let newColor = menuData[type][idx].rawColor; let newBg = menuData[type][idx].customStyle && menuData[type][idx].customStyle.includes('background-color:') ? menuData[type][idx].customStyle.match(/background-color:\s*([^;]+)/)[1] : '';
    let borderStyle = menuData[type][idx].customStyle && menuData[type][idx].customStyle.includes('border:') ? menuData[type][idx].customStyle.match(/border:\s*([^;]+)/)[0] + ';' : 'border: 1px solid transparent;';
    if (colorIdx !== null && colorIdx >= 0) { newColor = colorPresets[colorIdx].color; newBg = colorPresets[colorIdx].bg; borderStyle = colorPresets[colorIdx].border ? `border: 1px solid ${colorPresets[colorIdx].border};` : 'border: 1px solid transparent;'; }
    menuData[type][idx].text = newText; menuData[type][idx].customStyle = `background-color: ${newBg}; color: ${newColor}; ${borderStyle}`; menuData[type][idx].rawColor = newColor;
    let displayText = type === 'design' ? newText.replace(' ', '<br>') : newText;
    document.querySelectorAll('#tableBody tr').forEach(row => { 
        let cell = row.querySelector(`td[data-type="${type}"]`); 
        if (cell && (cell.dataset.val === oldText || cell.innerText.replace(/\n/g, ' ').trim() === oldText || cell.innerText.trim() === oldText)) { 
            cell.innerHTML = `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;"><span class="badge badge-status" style="${menuData[type][idx].customStyle} ${type === 'design' ? 'white-space:normal !important; text-align:center; height:auto; min-height:24px; line-height:1.1; padding:4px 8px;' : ''}">${displayText}</span></div>`; 
            cell.dataset.val = newText;
            if (typeof syncRowToDb === 'function') syncRowToDb(row);
        } 
    });
    saveData(); currentEditingCell.click(); 
}
window.deleteStatus = function(e, idx, type) {
    e.stopPropagation(); const text = menuData[type][idx].text;
    if(confirm(`Видалити варіант "${text}"?`)) { 
        recordUndoState(); menuData[type].splice(idx, 1); currentEditingCell.click(); 
        if (activeFilters[type] && activeFilters[type].includes(text)) { activeFilters[type] = activeFilters[type].filter(s => s !== text); applyFilters(); }
        saveData(); 
    }
}
function applyToCells(type, newValue, rawText) {
    recordUndoState();
    if (currentEditingCell.parentElement.classList.contains('selected')) { 
        document.querySelectorAll('.selected').forEach(row => { 
            let targetCell = row.querySelector(`td[data-type="${type}"]`); 
            if (targetCell) { 
                let oldVal = type === 'status' ? (targetCell.dataset.val || targetCell.innerText.trim()) : null;
                targetCell.innerHTML = newValue; 
                if(rawText !== undefined) targetCell.dataset.val = rawText; 
                if (type === 'status') checkAndDeductMaterials(row, oldVal, rawText);
                
                if (typeof syncRowToDb === 'function') syncRowToDb(row); // Синхронизация
            } 
        }); 
    } else { 
        let oldVal = type === 'status' ? (currentEditingCell.dataset.val || currentEditingCell.innerText.trim()) : null;
        currentEditingCell.innerHTML = newValue; 
        if(rawText !== undefined) currentEditingCell.dataset.val = rawText; 
        if (type === 'status') checkAndDeductMaterials(currentEditingCell.parentElement, oldVal, rawText);
        
        if (typeof syncRowToDb === 'function') syncRowToDb(currentEditingCell.parentElement); // Синхронизация
    }
}
// ==========================================
// ==========================================
// --- НОВА ФУНКЦІЯ: ДИНАМІЧНЕ АВТОМАТИЧНЕ СПИСАННЯ МАТЕРІАЛІВ ---
function checkAndDeductMaterials(row, oldStatus, newStatus) {
    if (!newStatus) return;
    const oldS = (oldStatus || '').toLowerCase();
    const newS = newStatus.toLowerCase();
    const isDoneStatus = (newS.includes('відправлено') || newS.includes('зроблено') || newS.includes('в роботі') || newS.includes('done')); 
    const wasDoneStatus = (oldS.includes('відправлено') || oldS.includes('зроблено') || oldS.includes('в роботі') || oldS.includes('done'));
    if (isDoneStatus && !wasDoneStatus) {
        const getVal = (dataType) => {
            const cell = row.querySelector(`td[data-type="${dataType}"]`);
            if (!cell) return '';
            let val = cell.dataset.val || cell.innerText;
            if (val.includes('<div') || val.includes('<span')) { const temp = document.createElement('div'); temp.innerHTML = val; val = temp.innerText; }
            return val.trim().toLowerCase();
        };
        const product = getVal('product');
        if (!product) return; 
        
        const colorsArr = getVal('color').split('\n').map(c => c.trim()).filter(Boolean);
        const sizesArr = getVal('size').split('\n').map(s => s.trim()).filter(Boolean);
        const effectiveSizes = sizesArr.length > 0 ? sizesArr : ['no_size'];
        let updated = false;
        let deductedLog = [];
        const isColorMat = (name) => {
            return (window.kopilkaColors && window.kopilkaColors.some(c => c.name.toLowerCase() === name.toLowerCase())) ||
                   (window.hwColors && window.hwColors.some(c => c.name.toLowerCase() === name.toLowerCase()));
        };
        materialsData.forEach(mat => {
            if (mat.isHidden) return; 
            if (!mat.rules || mat.rules.length === 0) return;
            let amountToDeduct = 0;
            const matIsColor = (mat.id && mat.id.startsWith('color_')) || isColorMat(mat.name);
            
            let originalColorName = mat.name;
            if (mat.id && mat.id.startsWith('color_')) { originalColorName = mat.id.replace('color_', ''); }
            mat.rules.forEach(rule => {
                const ruleProd = (rule.product || 'all').toLowerCase();
                const ruleSize = (rule.size || 'all').toLowerCase();
                const ruleColor = (rule.productColor || 'all').toLowerCase(); // Нове поле: колір товару
                const amt = parseFloat(rule.amount) || 0;
                
                const productMatches = (ruleProd === 'all' || product.includes(ruleProd));
                if (productMatches) {
                    const maxItems = Math.max(colorsArr.length, effectiveSizes.length, 1);
                    for(let i = 0; i < maxItems; i++) {
                        let c = colorsArr[i] || colorsArr[0] || '';
                        let s = effectiveSizes[i] || effectiveSizes[0] || 'no_size';
                        
                        let colorMatch = false;
                        if (ruleColor !== 'all') {
                            // Якщо в правилі чітко вказано колір товару, перевіряємо його
                            colorMatch = (c.toLowerCase() === ruleColor);
                        } else {
                            // Якщо не вказано, фарба списується тільки якщо її назва співпадає з кольором товару
                            colorMatch = !matIsColor || c.toLowerCase() === originalColorName.toLowerCase();
                        }
                        
                        let sizeMatch = (ruleSize === 'all' || s === ruleSize);
                        
                        if (colorMatch && sizeMatch) { amountToDeduct += amt; }
                    }
                }
            });
            if (amountToDeduct > 0) {
                mat.qty = parseFloat((mat.qty - amountToDeduct).toFixed(2));
                updated = true;
                deductedLog.push(`${mat.name} (-${amountToDeduct} ${mat.unit})`);
            }
        });
        if (updated) {
            db.collection("babak_crm").doc("materials_state").set({ items: materialsData });
            renderMaterialsTable(); 
            showToast(`📦 Списано: ${deductedLog.join(', ')}`); 
        }
    }
}
// --- ЛОГІКА ДЛЯ КОПІЛКИ ТА БІЛИХ ПЛАШОК ---
window.formatMultiRowHtml = function(pers, vals, fallback, type = '') {
    if (pers.length === 0) return `<div class="multi-wrapper"></div>`;
    // ЛОГИКА АВТО-ДУБЛИРОВАНИЯ:
    // Если у нас несколько предметов (имен), но только одно значение (дизайн/размер/цвет),
    // используем это единственное значение для всех строк вместо знака вопроса.
    let effectiveVals = [...vals];
    if (effectiveVals.length === 1 && pers.length > 1) {
        for (let i = 1; i < pers.length; i++) {
            effectiveVals.push(effectiveVals[0]);
        }
    }
    const createBadge = (v) => {
        if (!v || v === fallback) return `<span class="badge" style="background:white; color:#9a9a97; border:1px solid #d1d1d1;">?</span>`;
        let inner = v;
        if (type === 'color') {
            let colorObj = window.kopilkaColors.find(c => c.name === v) || window.hwColors.find(c => c.name === v) || (window.wtColors||[]).find(c => c.name === v);
            if (colorObj) { 
                inner = `<span style="display:inline-block; min-width:10px; width:10px; height:10px; background-color:${colorObj.hex}; border:1px solid rgba(0,0,0,0.15); border-radius:50%; margin-right:5px; flex-shrink:0;"></span><span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${v}</span>`; 
            }
        }
        return `<span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1;">${inner}</span>`;
    };
    if (pers.length === 1) { 
        return `<div class="multi-wrapper">${createBadge(effectiveVals[0] || fallback)}</div>`; 
    }
    
    let html = pers.map((p, i) => `<div class="multi-val-row" style="width:100%;">${createBadge(effectiveVals[i] || fallback)}</div>`).join('');
    return `<div class="multi-wrapper">${html}</div>`;
}
window.addPersInputRow = function(val = '', autoFocus = false) {
    const list = document.getElementById('persInputList');
    const row = document.createElement('div'); row.className = 'pers-input-row';
    row.innerHTML = `<input type="text" value="${val.replace(/"/g, '&quot;')}" placeholder="Введіть ім'я..." onkeydown="if(event.key==='Enter'){event.preventDefault(); window.addPersInputRow('', true);}"><div class="del-pers-btn" onclick="this.parentElement.remove()" title="Видалити"><svg viewBox="0 0 16 16" style="width:14px;height:14px;fill:currentColor;"><path d="M12.642 3.358a.625.625 0 0 0-.884 0L8 7.116 4.242 3.358a.625.625 0 1 0-.884.884L7.116 8l-3.758 3.758a.625.625 0 0 0 .884.884L8 8.884l3.758 3.758a.625.625 0 1 0 .884-.884L8.884 8l3.758-3.758a.625.625 0 1 0 .884-.884L8.884 8l3.758-3.758a.625.625 0 0 0 0-.884"></path></svg></div>`;
    list.appendChild(row); if (autoFocus) row.querySelector('input').focus();
}
window.openPersPopover = function(td, rect) {
    const popover = document.getElementById('persPopover'); const list = document.getElementById('persInputList'); list.innerHTML = '';
    let val = td.dataset.val || td.innerText;
    if (val.includes('<div') || val.includes('<span')) val = td.innerText;
    let vals = val.split('\n').map(v => v.trim()).filter(v => v);
    if (vals.length === 0) { window.addPersInputRow(''); } else { vals.forEach(v => window.addPersInputRow(v)); }
    window.smartPosition(popover, rect, 'over');
}
window.renderKopilkaColorList = function() {
    let html = '';
    const prodColors = window._activePopoverProduct
        ? window.getProductColors(window._activePopoverProduct)
        : window.kopilkaColors;
    activePersList.forEach((pers, i) => {
        let current = activeKopilkaColors[i] || '';
        let circlesHtml = prodColors.map(c => `<div class="k-color-btn ${current === c.name ? 'active' : ''}" style="background-color: ${c.hex};" title="${c.name}" onclick="setKopilkaColor(${i}, '${c.name}')"></div>`).join('');
        let blockClass = activePersList.length === 1 ? '' : 'kopilka-design-block';
        let paddingStyle = activePersList.length === 1 ? '' : 'padding: 12px; margin-bottom: 10px;';
        let headerHtml = activePersList.length === 1 ? '' : `<div class="k-design-header" style="margin-bottom:12px; justify-content:center;"><span class="k-pers-name" title="${pers.replace(/"/g, '&quot;')}">${pers}</span></div>`;
        html += `<div class="${blockClass}" style="${paddingStyle}">${headerHtml}<div style="display:flex; gap:10px; flex-wrap:wrap; justify-content: center; min-height: 28px;">${circlesHtml}</div></div>`;
    });
    document.getElementById('kopilkaColorList').innerHTML = html;
}
window.setKopilkaColor = function(i, colorName) { activeKopilkaColors[i] = colorName; renderKopilkaColorList(); }
window.openKopilkaColorPopover = function(td, rect, row) {
    const popover = document.getElementById('kopilkaColorPopover');
    // Запам'ятовуємо поточний товар рядка
    const prodTd = row.querySelector('td[data-type="product"]');
    window._activePopoverProduct = (prodTd?.dataset.val || prodTd?.innerText || '').trim() || null;
    const persTd = row.children[5];
    let persVals = persTd.dataset.val ? persTd.dataset.val.split('\n') : (persTd.innerText ? persTd.innerText.split('\n') : []);
    activePersList = persVals.map(v => v.trim()).filter(v => v);
    if (activePersList.length === 0) activePersList = ['Товар 1'];
    let colorVals = td.dataset.val ? td.dataset.val.split('\n') : [];
    activeKopilkaColors = activePersList.map((_, i) => colorVals[i] || '');
    renderKopilkaColorList();
    window.smartPosition(popover, rect, 'over');
}
window.renderKopilkaSizeList = function() {
    let html = '';
    const prodSizes = window._activePopoverProduct
        ? window.getProductSizes(window._activePopoverProduct)
        : ['S', 'M'];
    activePersList.forEach((pers, i) => {
        let current = activeKopilkaSizes[i] || '';
        let options = prodSizes.map(s => `<button class="k-size-btn ${current === s ? 'active' : ''}" onclick="setKopilkaSize(${i}, '${s}')">${s}</button>`).join('');
        if (activePersList.length === 1) { html += `<div style="display:flex; gap:6px; justify-content:center;">${options}</div>`; } else {
            html += `<div class="kopilka-design-block" style="padding: 12px; margin-bottom: 10px;"><div class="k-design-header" style="margin-bottom:12px; justify-content:center;"><span class="k-pers-name" title="${pers.replace(/"/g, '&quot;')}">${pers}</span></div><div class="kopilka-size-options">${options}</div></div>`;
        }
    });
    document.getElementById('kopilkaSizeList').innerHTML = html;
}
window.setKopilkaSize = function(i, size) { activeKopilkaSizes[i] = size; renderKopilkaSizeList(); }
window.openKopilkaSizePopover = function(td, rect, row) {
    const popover = document.getElementById('kopilkaSizePopover');
    const prodTd = row.querySelector('td[data-type="product"]');
    window._activePopoverProduct = (prodTd?.dataset.val || prodTd?.innerText || '').trim() || null;
    const persTd = row.children[5];
    let persVals = persTd.dataset.val ? persTd.dataset.val.split('\n') : (persTd.innerText ? persTd.innerText.split('\n') : []);
    activePersList = persVals.map(v => v.trim()).filter(v => v);
    if (activePersList.length === 0) activePersList = ['Товар 1'];
    let sizeVals = td.dataset.val ? td.dataset.val.split('\n') : [];
    activeKopilkaSizes = activePersList.map((_, i) => sizeVals[i] || '');
    renderKopilkaSizeList();
    window.smartPosition(popover, rect, 'over');
}
window.renderKopilkaDesignList = function() {
    let html = '';
    activePersList.forEach((pers, i) => {
        let val = activeKopilkaDesigns[i] || ''; let letter = val.charAt(0) || ''; let num = val.includes('-') ? val.split('-')[1].trim() : '';
        let lettersHtml = ['A','B','C','D','E','F'].map(l => `<div class="design-letter-btn ${letter === l ? 'active' : ''}" onclick="setKDLetter(${i}, '${l}')">${l}</div>`).join('');
        let numsHtml = '';
        if (letter === 'C') { for(let n=1; n<=16; n++) { numsHtml += `<div class="design-number-btn ${num == n ? 'active' : ''}" onclick="setKDNum(${i}, '${n}')">${n}</div>`; } }
        let headerHtml = activePersList.length === 1 ? '' : `<div class="k-design-header" style="margin-bottom:12px; justify-content:center;"><span class="k-pers-name" title="${pers.replace(/"/g, '&quot;')}">${pers}</span></div>`;
        let blockClass = activePersList.length === 1 ? '' : 'kopilka-design-block'; let paddingStyle = activePersList.length === 1 ? '' : 'padding: 12px; margin-bottom: 10px;';
        html += `<div class="${blockClass}" style="${paddingStyle}">${headerHtml}<div class="design-letters">${lettersHtml}</div><div class="design-numbers ${letter === 'C' ? 'active' : ''}">${numsHtml}</div></div>`;
    });
    document.getElementById('kopilkaDesignList').innerHTML = html;
}
window.setKDLetter = function(idx, letter) {
    let val = activeKopilkaDesigns[idx] || ''; let currentNum = val.includes('-') ? val.split('-')[1].trim() : '';
    if (letter === 'C') { activeKopilkaDesigns[idx] = `C - ${currentNum || '1'}`; } else { activeKopilkaDesigns[idx] = letter; }
    renderKopilkaDesignList();
}
window.setKDNum = function(idx, num) { activeKopilkaDesigns[idx] = `C - ${num}`; renderKopilkaDesignList(); }
window.openKopilkaDesignPopover = function(td, rect, row) {
    const popover = document.getElementById('kopilkaDesignPopover');
    const persTd = row.children[5];
    let persVals = persTd.dataset.val ? persTd.dataset.val.split('\n') : (persTd.innerText ? persTd.innerText.split('\n') : []);
    activePersList = persVals.map(v => v.trim()).filter(v => v);
    if (activePersList.length === 0) activePersList = ['Товар 1'];
    let designVals = td.dataset.val ? td.dataset.val.split('\n') : [];
    activeKopilkaDesigns = activePersList.map((_, i) => designVals[i] || '');
    renderKopilkaDesignList();
    window.smartPosition(popover, rect, 'over');
}
window.addHwPersRow = function(type, text) {
    const list = document.getElementById('hwPersInputList');
    let label = type === 'Tab' ? 'Табличка' : 'Вантажівка'; let id = 'hwInp' + type;
    const row = document.createElement('div'); row.className = 'pers-input-row'; row.id = 'hwRow' + type;
    row.innerHTML = `<div style="flex-shrink: 0; width: 75px; font-size:12px; color:var(--c-texPri); font-weight:500;">${label}</div><input type="text" id="${id}" value="${text === 'є' ? '' : text.replace(/"/g, '&quot;')}" placeholder="Введіть текст..." onkeydown="if(event.key==='Enter'){event.preventDefault(); window.closeAllPopovers();}"><div class="del-pers-btn" onclick="this.parentElement.remove()" title="Видалити"><svg viewBox="0 0 16 16" style="width:14px;height:14px;fill:currentColor;"><path d="M12.642 3.358a.625.625 0 0 0-.884 0L8 7.116 4.242 3.358a.625.625 0 1 0-.884.884L7.116 8l-3.758 3.758a.625.625 0 0 0 .884.884L8 8.884l3.758 3.758a.625.625 0 1 0 .884-.884L8.884 8l3.758-3.758a.625.625 0 1 0 .884-.884L8.884 8l3.758-3.758a.625.625 0 0 0 0-.884"></path></svg></div>`;
    list.appendChild(row);
};
window.restoreHwFields = function() {
    if (!document.getElementById('hwRowTab')) window.addHwPersRow('Tab', '');
    if (!document.getElementById('hwRowVan')) window.addHwPersRow('Van', '');
};
window.openHwPersPopover = function(td, rect) {
    closeAllPopovers(); currentEditingCell = td;
    let val = td.dataset.val || ''; if (val.includes('<div') || val.includes('<span')) val = td.innerText.trim();
    let hasTab = val === '' || val.includes('Табличка:'); let hasVan = val === '' || val.includes('Вантажівка:');
    let tabText = ''; let vanText = '';
    if (val !== '') { val.split('\n').forEach(line => { if(line.startsWith('Табличка:')) tabText = line.replace('Табличка:', '').trim(); if(line.startsWith('Вантажівка:')) vanText = line.replace('Вантажівка:', '').trim(); }); }
    const list = document.getElementById('hwPersInputList'); list.innerHTML = '';
    if (val === '') { window.addHwPersRow('Tab', ''); window.addHwPersRow('Van', ''); } else { if (hasTab) window.addHwPersRow('Tab', tabText); if (hasVan) window.addHwPersRow('Van', vanText); }
    const popover = document.getElementById('hwPersPopover');
    window.smartPosition(popover, rect, 'over');
}
window.openHwColorPopover = function(td, rect) {
    closeAllPopovers(); currentEditingCell = td;
    let current = td.dataset.val || td.innerText.trim(); if (current.includes('<div') || current.includes('<span')) current = td.innerText.trim();
    let html = window.hwColors.map(c => `<div class="k-color-btn ${current === c.name ? 'active' : ''}" style="background-color: ${c.hex};" title="${c.name}" onclick="setHwColor('${c.name.replace(/'/g, "\\'")}')"></div>`).join('');
    document.getElementById('hwColorList').innerHTML = html;
    window.smartPosition(document.getElementById('hwColorPopover'), rect, 'over');
}
window.setHwColor = function(colorName) {
    recordUndoState();
    let colorObj = window.hwColors.find(c => c.name === colorName);
    let inner = `<span style="display:inline-block; min-width:10px; width:10px; height:10px; background-color:${colorObj.hex}; border:1px solid rgba(0,0,0,0.15); border-radius:50%; margin-right:5px; flex-shrink:0;"></span><span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${colorName}</span>`;
    let badgeHtml = `<span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1;">${inner}</span>`;
    currentEditingCell.dataset.val = colorName; currentEditingCell.innerHTML = `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;">${badgeHtml}</div>`;
    saveData(); closeAllPopovers();
    if (typeof syncRowToDb === 'function') syncRowToDb(currentEditingCell.closest('tr'));
}
window.openHwSizePopover = function(td, rect) {
    closeAllPopovers(); currentEditingCell = td;
    let current = td.dataset.val || td.innerText.trim(); if (current.includes('<div') || current.includes('<span')) current = td.innerText.trim();
    let html = window.hwSizes.map(s => `<button class="k-size-btn ${current === s ? 'active' : ''}" onclick="setHwSize('${s}')">${s}</button>`).join('');
    document.getElementById('hwSizeList').innerHTML = html;
    window.smartPosition(document.getElementById('hwSizePopover'), rect, 'over');
}
window.setHwSize = function(size) {
    recordUndoState();
    currentEditingCell.dataset.val = size;
    let badgeHtml = `<span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1;">${size}</span>`;
    currentEditingCell.innerHTML = `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;">${badgeHtml}</div>`;
    saveData(); closeAllPopovers();
}
window.openHwDesignPopover = function(td, rect) {
    closeAllPopovers(); currentEditingCell = td;
    let current = td.dataset.val || td.innerText.trim();
    if (current.includes('<div') || current.includes('<span')) current = td.innerText.trim();
    // Парсимо збережене значення: може бути "З/А | Поличка: +"
    let currentDesign = current;
    let currentShelf = '+'; // --- ДЕФОЛТ: завжди "+"
    if (current.includes(' | Поличка: ')) {
        const parts = current.split(' | Поличка: ');
        currentDesign = parts[0].trim();
        currentShelf = parts[1].trim();
    }
    // Синхронізуємо глобальний стан одразу при відкритті
    window._hwDesignPart = currentDesign;
    window._hwShelfPart  = currentShelf;
    // Якщо є дизайн але поличка ще не збережена — зберігаємо дефолт "+" одразу
    if (currentDesign && !(td.dataset.val || '').includes(' | Поличка: ')) {
        const rawVal = currentDesign + ' | Поличка: ' + currentShelf;
        td.dataset.val = rawVal;
        td.innerHTML = window.renderHwDesignHtml(currentDesign, currentShelf);
        saveData();
        if (typeof syncRowToDb === 'function') syncRowToDb(td.closest('tr'));
    }
    // З/А і Б/А кнопки
    let html = window.hwDesigns.map(d =>
        `<button class="hw-design-btn ${currentDesign === d ? 'active' : ''}" onclick="setHwDesignPart('${d}')">${d}</button>`
    ).join('');
    document.getElementById('hwDesignList').innerHTML = html;
    // Поличка: + / −
    let shelfHtml = ['+', '−'].map(v =>
        `<button class="hw-design-btn ${currentShelf === v ? 'active' : ''}" onclick="setHwShelfPart('${v}')">${v}</button>`
    ).join('');
    document.getElementById('hwShelfList').innerHTML = shelfHtml;
    window.smartPosition(document.getElementById('hwDesignPopover'), rect, 'over');
};
// Зберігаємо проміжний стан дизайну
window._hwDesignPart = '';
window._hwShelfPart  = '';
window.setHwDesignPart = function(design) {
    // Використовуємо синхронізований стан, не читаємо повторно з DOM
    window._hwDesignPart = design;
    // Якщо поличка ще не встановлена — дефолт +
    if (!window._hwShelfPart) window._hwShelfPart = '+';
    window._applyHwDesign();
    document.querySelectorAll('#hwDesignList .hw-design-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.trim() === design);
    });
};
window.setHwShelfPart = function(shelf) {
    // Використовуємо синхронізований стан дизайну
    if (!window._hwDesignPart) {
        const current = currentEditingCell.dataset.val || '';
        window._hwDesignPart = current.includes(' | Поличка: ') ? current.split(' | Поличка: ')[0].trim() : current.trim();
    }
    // Якщо натиснули вже активну — знімаємо (toggle)
    if (window._hwShelfPart === shelf) {
        shelf = '';
    }
    window._hwShelfPart = shelf;
    window._applyHwDesign();
    document.querySelectorAll('#hwShelfList .hw-design-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.trim() === shelf);
    });
};
window._applyHwDesign = function() {
    recordUndoState();
    const design = window._hwDesignPart;
    const shelf  = window._hwShelfPart;
    if (!design && !shelf) return;
    let rawVal = design;
    if (shelf) rawVal += ' | Поличка: ' + shelf;
    currentEditingCell.dataset.val = rawVal;
    currentEditingCell.innerHTML = window.renderHwDesignHtml(design, shelf);
    saveData();
    if (typeof syncRowToDb === 'function') syncRowToDb(currentEditingCell.closest('tr'));
};
// Рендер клітинки дизайну для Хотвілс — два рядочки як у персоналізації
window.renderHwDesignHtml = function(design, shelf) {
    const makeBadgeBlock = (label, value) => `
        <div style="display:flex; flex-direction:column; align-items:center; margin-bottom:4px;">
            <div style="font-size:10px; color:var(--c-texSec); font-weight:500; margin-bottom:2px; line-height:1;">${label}</div>
            <span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1; white-space:normal !important; text-align:center; height:auto; min-height:22px; line-height:1.1; padding:3px 8px; font-size:12px;">${value}</span>
        </div>`;
    let html = '';
    if (shelf)  html += makeBadgeBlock('Пол.', shelf);
    if (design) html += makeBadgeBlock('Акрил', design);
    return `<div class="clamp-wrapper" style="align-items:center; display:flex; flex-direction:column; justify-content:center; height:100%; width:100%;">${html}</div>`;
};
window.setHwDesign = function(design) {
    recordUndoState();
    currentEditingCell.dataset.val = design;
    currentEditingCell.innerHTML = window.renderHwDesignHtml(design, '');
    saveData(); closeAllPopovers();
}
window.switchView = function(viewId) {
    document.getElementById('ordersView').style.display = 'none';
    document.getElementById('materialsView').style.display = 'none';
    const pv = document.getElementById('productsView');
    if (pv) pv.style.display = 'none';
    const fv = document.getElementById('financesView');
    if (fv) fv.style.display = 'none';
    const wv = document.getElementById('wbView');
    if (wv) wv.style.display = 'none';
    const sv = document.getElementById('shippingView');
    if (sv) sv.style.display = 'none';
    document.getElementById(viewId).style.display = 'block';
    const tabs = document.querySelectorAll('.page-tabs .tab');
    tabs.forEach(t => t.classList.remove('active'));
    const viewOrder = ['ordersView', 'materialsView', 'productsView', 'financesView', 'wbView', 'shippingView'];
    const idx = viewOrder.indexOf(viewId);
    if (idx >= 0 && tabs[idx]) tabs[idx].classList.add('active');
    if (viewId === 'materialsView') {
        try { renderMaterialsTable(); } catch(e) {}
    }
    if (viewId === 'productsView') {
        const tryRender = (attempts) => {
            if (typeof window.renderProductsDashboard === 'function' && menuData && menuData.product) {
                window.renderProductsDashboard();
            } else if (attempts > 0) {
                setTimeout(() => tryRender(attempts - 1), 200);
            }
        };
        tryRender(10);
    }
    if (viewId === 'financesView') {
        const tryRender = (attempts) => {
            if (typeof window.renderFinancesDashboard === 'function') {
                window.renderFinancesDashboard();
            } else if (attempts > 0) {
                setTimeout(() => tryRender(attempts - 1), 200);
            }
        };
        tryRender(10);
    }
    if (viewId === 'wbView') {
        setTimeout(() => window.wbLoadWarehouseSelect?.(), 200);
        if (window._wbSelectedRow) window.wbFillPanelFromRow(window._wbSelectedRow);
    }
}
function saveText() {
    let changed = false;
    if(textInputPopover.classList.contains('active') && currentEditingCell) { 
        const val = cellInput.value.trim(); const oldVal = currentEditingCell.dataset.val || currentEditingCell.innerText.trim();
        if (val !== oldVal) { recordUndoState(); currentEditingCell.dataset.val = val; currentEditingCell.innerHTML = `<div class="clamp-wrapper">${val.replace(/\n/g, '<br>')}</div>`; changed = true; }
   } else if (document.getElementById('persPopover').classList.contains('active') && currentEditingCell) {
        recordUndoState(); 
        const inputs = Array.from(document.querySelectorAll('#persInputList .pers-input-row input')).map(i => i.value.trim()).filter(v => v);
        currentEditingCell.dataset.val = inputs.join('\n'); let displayHtml = inputs.map(v => { let textVal = v.replace(/"/g, '&quot;'); return `<div class="multi-val-row" style="justify-content: center;"><span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1; padding:2px 8px; font-size:12px; height:auto; min-height:22px; line-height:1.2; text-transform:none; font-weight:500; display:inline-block; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:center;" title="${textVal}">${textVal}</span></div>`; }).join('');
        currentEditingCell.innerHTML = `<div class="clamp-wrapper" style="width:100%; text-align:center;">${displayHtml}</div>`; changed = true;
    } else if (document.getElementById('hwPersPopover').classList.contains('active') && currentEditingCell) {
        recordUndoState(); let tabRow = document.getElementById('hwRowTab'); let tabInp = document.getElementById('hwInpTab'); let vanRow = document.getElementById('hwRowVan'); let vanInp = document.getElementById('hwInpVan');
        let lines = []; if (tabRow && tabInp) lines.push(`Табличка: ${tabInp.value.trim() || 'є'}`); if (vanRow && vanInp) lines.push(`Вантажівка: ${vanInp.value.trim() || 'є'}`);
        let rawVal = lines.join('\n'); let displayHtml = lines.map(l => { let parts = l.split(': '); let title = parts[0]; let textVal = parts[1] === 'є' ? 'Без тексту' : parts[1].replace(/"/g, '&quot;'); return `<div style="display:flex; flex-direction:column; margin-bottom:6px; align-items:center;"><div style="font-size:11px; color:var(--c-texSec); margin-bottom:2px; line-height:1; font-weight:400;">${title}</div><span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1; padding:2px 8px; font-size:12px; height:auto; min-height:24px; text-transform:none; font-weight:500; display:inline-block; max-width:100%; white-space:normal !important; line-height:1.2; text-align:center;">${textVal}</span></div>`; }).join('');
        currentEditingCell.dataset.val = rawVal; currentEditingCell.innerHTML = `<div class="clamp-wrapper" style="width:100%; display:flex; flex-direction:column; align-items:center;">${displayHtml}</div>`; changed = true;
    } else if (document.getElementById('wtPersPopover').classList.contains('active') && currentEditingCell) {
        recordUndoState();
        const para  = document.getElementById('wtInpPara')  ? document.getElementById('wtInpPara').value.trim()  : '';
        const prizv = document.getElementById('wtInpPrizv') ? document.getElementById('wtInpPrizv').value.trim() : '';
        const data  = document.getElementById('wtInpData')  ? document.getElementById('wtInpData').value.trim()  : '';
        const parts = [];
        if (para)  parts.push('Пара імен: ' + para);
        if (prizv) parts.push('Прізвище: ' + prizv);
        if (data)  parts.push('Дата: ' + data);
        const rawVal = parts.join('\n');
        currentEditingCell.dataset.val = rawVal;
        currentEditingCell.innerHTML = window.formatWtPersHtml(rawVal);
        changed = true;
    } else if (document.getElementById('kopilkaColorPopover').classList.contains('active') && currentEditingCell) { recordUndoState(); currentEditingCell.dataset.val = activeKopilkaColors.join('\n'); currentEditingCell.innerHTML = window.formatMultiRowHtml(activePersList, activeKopilkaColors, '?', 'color'); changed = true;
    } else if (document.getElementById('kopilkaSizePopover').classList.contains('active') && currentEditingCell) { recordUndoState(); currentEditingCell.dataset.val = activeKopilkaSizes.join('\n'); currentEditingCell.innerHTML = window.formatMultiRowHtml(activePersList, activeKopilkaSizes, '?'); changed = true;
    } else if (document.getElementById('kopilkaDesignPopover').classList.contains('active') && currentEditingCell) { recordUndoState(); currentEditingCell.dataset.val = activeKopilkaDesigns.join('\n'); currentEditingCell.innerHTML = window.formatMultiRowHtml(activePersList, activeKopilkaDesigns, '?'); changed = true; }
    if (changed) {
        saveData();
        if (currentEditingCell && typeof syncRowToDb === 'function') {
            syncRowToDb(currentEditingCell.closest('tr'));
        }
    }
}
window.hidePopover = function(element) { element.classList.remove('active'); }
window.closeAllPopovers = function(e, keepPending = false) { 
    if (e && e.target && e.target.closest('.flatpickr-calendar')) return; 
    if (e && e.target && e.target.closest('.modal-overlay')) return;
    if (e && e.target && e.target.closest('.search-container')) return;
    if (e && e.target && e.target.closest('#chatPopover')) return;
    if (e && e.target && e.target.closest('#persPopover')) return;
    if (e && e.target && e.target.closest('#kopilkaColorPopover')) return;
    if (e && e.target && e.target.closest('#kopilkaSizePopover')) return;
    if (e && e.target && e.target.closest('#kopilkaDesignPopover')) return;
    if (e && e.target && e.target.closest('#hwPersPopover')) return;
    if (e && e.target && e.target.closest('#hwColorPopover')) return;
    if (e && e.target && e.target.closest('#hwSizePopover')) return;
    if (e && e.target && e.target.closest('#hwDesignPopover')) return;
    if (e && e.target && e.target.closest('#wtPersPopover')) return;
    if (e && e.target && e.target.closest('#wtColorPopover')) return;
    if (e && e.target && e.target.closest('#wtSizePopover')) return;
    
    if (e && e.target && e.target.closest('#filterMenu')) return; 
    if (e && e.target && e.target.closest('#rowContextMenu')) return; 
    
    saveText(); 
    if (!keepPending) pendingCommentCoords = null;
    
    hidePopover(dropdownMenu); hidePopover(newTemplateMenu); hidePopover(textInputPopover); 
    hidePopover(document.getElementById('filterMenu')); hidePopover(document.getElementById('userMenu')); hidePopover(document.getElementById('chatPopover'));
    hidePopover(document.getElementById('persPopover')); hidePopover(document.getElementById('kopilkaColorPopover'));
    hidePopover(document.getElementById('kopilkaSizePopover')); hidePopover(document.getElementById('kopilkaDesignPopover'));
    hidePopover(document.getElementById('hwPersPopover')); hidePopover(document.getElementById('hwColorPopover'));
    hidePopover(document.getElementById('hwSizePopover')); hidePopover(document.getElementById('hwDesignPopover'));
    hidePopover(document.getElementById('wtPersPopover')); hidePopover(document.getElementById('wtColorPopover'));
    hidePopover(document.getElementById('wtSizePopover'));
    hidePopover(document.getElementById('rowContextMenu'));
    
    if (!keepPending && pendingServerHtml !== null) {
        const stillActive = document.querySelector('.popover.active') !== null || document.querySelector('.modal-overlay.active') !== null;
        if (!stillActive) {
            applyHtmlFromServer(pendingServerHtml);
            if(pendingServerMenu) menuData = { ...menuData, ...pendingServerMenu };
            pendingServerHtml = null;
            pendingServerMenu = null;
        }
    }
}
document.addEventListener('click', (e) => {
    if (marqueeDragDistance > 5) { marqueeDragDistance = 0; return; }
    closeAllPopovers(e);
    
    if (!e.target.closest('table') && !e.target.closest('.table-actions-bar') && !e.target.closest('.popover') && !e.target.closest('.modal-overlay')) {
        const selectedRows = document.querySelectorAll('tr.selected');
        if (selectedRows.length > 0) {
            selectedRows.forEach(tr => { tr.classList.remove('selected'); const cb = tr.querySelector('.row-checkbox'); if (cb) { cb.checked = false; cb.removeAttribute('checked'); } });
            updateActionButtons();
            saveData();
        }
    }
});
scrollContainer.addEventListener('scroll', closeAllPopovers);
window.printSelected = function() { 
    const selectedCount = document.querySelectorAll('.selected').length;
    if(selectedCount === 0) { document.body.classList.add('print-all'); window.print(); document.body.classList.remove('print-all'); } else { window.print(); }
}
window.openOrderDetailsModal = function(row) {
    const modal = document.getElementById('orderDetailsModal');
    const content = document.getElementById('orderDetailsContent');
    let history = [];
    try { history = JSON.parse(row.dataset.history || '[]'); } catch(e) {}
    if (history.length === 0) {
        content.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--c-texSec);">Історія статусів порожня.<br>Вона почне записуватись для всіх нових замовлень.</div>';
    } else {
        let html = '';
        for (let i = 0; i < history.length; i++) {
            const step = history[i];
            const dateStr = new Date(step.t).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            let stItem = menuData['status'].find(s => s.text === step.s);
            let badgeStyle = stItem && stItem.customStyle ? stItem.customStyle : 'background: white; border: 1px solid var(--ca-borSecTra); color: var(--c-texPri);';
            let badgeClass = stItem && stItem.class ? stItem.class : 'badge-status';
            let actionText = (i === 0 || step.isCreation) ? "Створено в таблиці:" : "Змінено на:";
            html += `<div style="margin-bottom: 8px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px;">
                        <strong style="font-size: 13px; color: var(--c-texPri);">${dateStr}</strong>
                        <span style="font-size: 12px; color: var(--c-texSec);">${actionText}</span>
                        <span class="badge ${badgeClass}" style="${badgeStyle} padding: 2px 8px; height: auto; min-height: 20px;">${step.s}</span>
                     </div>`;
            if (i < history.length - 1) {
                const diffMs = history[i+1].t - step.t;
                html += `<div style="font-size: 11px; color: var(--c-texTer); margin-left: 12px; border-left: 1px dashed var(--ca-borSecTra); padding: 6px 0 6px 14px; margin-bottom: 8px;">
                            ⏱ В цьому статусі замовлення було: <b>${formatTimeDiff(diffMs)}</b>
                         </div>`;
            } else {
                 const statusTextLower = step.s.toLowerCase();
                 if (statusTextLower === 'відправлено' || statusTextLower === 'done' || statusTextLower === 'зроблено') {
                     const totalDiff = step.t - history[0].t;
                     html += `<div style="font-size: 11px; color: #4b9a52; margin-left: 12px; padding: 6px 0 0 14px; margin-bottom: 8px;">
                                🎉 Загальний час виконання: <b>${formatTimeDiff(totalDiff)}</b>
                             </div>`;
                 } else {
                     const currentDiff = Date.now() - step.t;
                     html += `<div style="font-size: 11px; color: #2383e2; margin-left: 12px; padding: 6px 0 0 14px; margin-bottom: 8px;">
                                ⏳ Поточний статус триває: <b>${formatTimeDiff(currentDiff)}</b>
                             </div>`;
                 }
            }
        }
        content.innerHTML = html;
    }
    modal.classList.add('active');
}
window.closeOrderDetailsModal = function() { document.getElementById('orderDetailsModal').classList.remove('active'); }
function formatTimeDiff(ms) {
    let mins = Math.floor(ms / 60000);
    if (mins === 0) return 'менше хвилини';
    let hours = Math.floor(mins / 60);
    let days = Math.floor(hours / 24);
    mins = mins % 60;
    hours = hours % 24;
    let res = [];
    if (days > 0) res.push(`${days} дн.`);
    if (hours > 0) res.push(`${hours} год.`);
    if (mins > 0 || res.length === 0) res.push(`${mins} хв.`);
    return res.join(' ');
}
function updateRowNumbers() {
    const allRows = Array.from(document.querySelectorAll('#tableBody tr'));
    // Якщо хоча б один рядок має Firebase-номер — показуємо Firebase-номери (вони незмінні)
    const hasFirebaseNumbers = allRows.some(r => r.dataset.orderNumber);
    if (hasFirebaseNumbers) {
        allRows.forEach(row => {
            const numSpan = row.querySelector('.row-num');
            if (numSpan && row.dataset.orderNumber) {
                numSpan.innerText = row.dataset.orderNumber;
            }
        });
    } else {
        // Fallback: позиційна нумерація поки Firebase не завантажив номери
        const visible = allRows.filter(r => r.style.display !== 'none' || r.classList.contains('hidden-by-pagination'));
        let count = visible.length;
        visible.forEach(row => {
            const numSpan = row.querySelector('.row-num');
            if (numSpan) numSpan.innerText = count--;
        });
    }
}
// ==========================================
// --- НОВА ФУНКЦІЯ: ДИНАМІЧНЕ АВТОМАТИЧНЕ СПИСАННЯ МАТЕРІАЛІВ ---
function checkAndDeductMaterials(row, oldStatus, newStatus) {
    if (!newStatus) return;
    const oldS = (oldStatus || '').toLowerCase();
    const newS = newStatus.toLowerCase();
    const isDoneStatus = (newS.includes('відправлено') || newS.includes('зроблено') || newS.includes('в роботі') || newS.includes('done')); 
    const wasDoneStatus = (oldS.includes('відправлено') || oldS.includes('зроблено') || oldS.includes('в роботі') || oldS.includes('done'));
    if (isDoneStatus && !wasDoneStatus) {
        const getVal = (dataType) => {
            const cell = row.querySelector(`td[data-type="${dataType}"]`);
            if (!cell) return '';
            let val = cell.dataset.val || cell.innerText;
            if (val.includes('<div') || val.includes('<span')) { const temp = document.createElement('div'); temp.innerHTML = val; val = temp.innerText; }
            return val.trim().toLowerCase();
        };
        const product = getVal('product');
        if (!product) return; 
        
        const colorsArr = getVal('color').split('\n').map(c => c.trim()).filter(Boolean);
        const sizesArr = getVal('size').split('\n').map(s => s.trim()).filter(Boolean);
        const effectiveSizes = sizesArr.length > 0 ? sizesArr : ['no_size'];
        let updated = false;
        let deductedLog = [];
        const isColorMat = (name) => {
            return (window.kopilkaColors && window.kopilkaColors.some(c => c.name.toLowerCase() === name.toLowerCase())) ||
                   (window.hwColors && window.hwColors.some(c => c.name.toLowerCase() === name.toLowerCase()));
        };
        materialsData.forEach(mat => {
            if (mat.isHidden) return; // Пропускаємо видалені
            if (!mat.rules || mat.rules.length === 0) return;
            let amountToDeduct = 0;
            const matIsColor = (mat.id && mat.id.startsWith('color_')) || isColorMat(mat.name);
            
            let originalColorName = mat.name;
            if (mat.id && mat.id.startsWith('color_')) { originalColorName = mat.id.replace('color_', ''); }
            const orderColorsLower = colorsArr.map(c => c.toLowerCase());
            if (matIsColor && !orderColorsLower.includes(originalColorName.toLowerCase())) return;
            mat.rules.forEach(rule => {
                const ruleProd = (rule.product || 'all').toLowerCase();
                const ruleSize = (rule.size || 'all').toLowerCase();
                const amt = parseFloat(rule.amount) || 0;
                const productMatches = (ruleProd === 'all' || product.includes(ruleProd));
                if (productMatches) {
                    const maxItems = Math.max(colorsArr.length, effectiveSizes.length, 1);
                    for(let i = 0; i < maxItems; i++) {
                        let c = colorsArr[i] || colorsArr[0] || '';
                        let s = effectiveSizes[i] || effectiveSizes[0] || 'no_size';
                        let colorMatch = !matIsColor || c.toLowerCase() === originalColorName.toLowerCase();
                        let sizeMatch = (ruleSize === 'all' || s === ruleSize);
                        if (colorMatch && sizeMatch) { amountToDeduct += amt; }
                    }
                }
            });
            if (amountToDeduct > 0) {
                mat.qty = parseFloat((mat.qty - amountToDeduct).toFixed(2));
                updated = true;
                deductedLog.push(`${mat.name} (-${amountToDeduct} ${mat.unit})`);
            }
        });
        if (updated) {
            db.collection("babak_crm").doc("materials_state").set({ items: materialsData });
            renderMaterialsTable(); 
            showToast(`📦 Списано: ${deductedLog.join(', ')}`); 
        }
    }
}
// ==========================================
// ЕТАП 2.1: ІНФОГРАФІКА СКЛАДУ 
// ==========================================
let materialsData = [];
db.collection("babak_crm").doc("materials_state").onSnapshot((doc) => {
    if (doc.exists) { materialsData = doc.data().items || []; renderMaterialsTable(); } 
    else { materialsData = []; renderMaterialsTable(); }
    // Оновлюємо попередження в усіх рядках при зміні складу
    setTimeout(updateAllMaterialWarnings, 100);
});
// =====================================================================
// === ПЕРЕВІРКА ЗАЛИШКІВ МАТЕРІАЛІВ ДЛЯ ЗАМОВЛЕНЬ ===
// =====================================================================
// Статуси при яких попередження НЕ показуємо
const MAT_WARN_SKIP_STATUSES = new Set(['Відправка', 'Накладна', 'Відправлено']);
// Надійне читання статусу рядка
function _getRowStatus(row) {
    const cell = row.querySelector('td[data-type="status"]');
    if (!cell) return '';
    return (cell.dataset.val || cell.querySelector('.badge')?.innerText || cell.innerText || '').trim();
}
function getMaterialWarningsForRow(row) {
    const colorWarnings = [];
    const basicWarnings = [];
    if (!materialsData || !materialsData.length) return { colorWarnings, basicWarnings };
    // Пропускаємо статуси де товар вже в процесі відправки
    const statusVal = _getRowStatus(row);
    if (MAT_WARN_SKIP_STATUSES.has(statusVal)) return { colorWarnings, basicWarnings };
    const allColorNames = new Set([
        ...(window.kopilkaColors || []).map(c => c.name),
        ...(window.hwColors || []).map(c => c.name),
        ...(window.wtColors || []).map(c => c.name),
    ]);
    // Кольори замовлення
    const colorCell = row.querySelector('td[data-type="color"]');
    if (colorCell) {
        const colorNames = (colorCell.dataset.val || '').split('\n').map(s => s.trim()).filter(Boolean);
        colorNames.forEach(colorName => {
            const mat = materialsData.find(m => !m.isHidden && m.name === colorName);
            if (!mat) return;
            const threshold = parseFloat(mat.threshold) || 0;
            const qty = parseFloat(mat.qty) || 0;
            if (qty <= threshold) {
                colorWarnings.push({ name: mat.name, qty: mat.qty || 0, threshold, unit: mat.unit || '', isEmpty: qty <= 0 });
            }
        });
    }
    // Всі інші матеріали (фанера, картон, скотч тощо)
    // Показуємо якщо qty=0 АБО якщо виставлений мінімум і qty <= мінімум
    materialsData.forEach(mat => {
        if (mat.isHidden) return;
        if (allColorNames.has(mat.name) || (mat.id && mat.id.startsWith('color_'))) return;
        const threshold = parseFloat(mat.threshold) || 0;
        const qty = parseFloat(mat.qty) || 0;
        const isEmpty = qty <= 0;
        const isBelowThreshold = threshold > 0 && qty <= threshold;
        if (isEmpty || isBelowThreshold) {
            basicWarnings.push({ name: mat.name, qty: mat.qty || 0, threshold, unit: mat.unit || '', isEmpty });
        }
    });
    return { colorWarnings, basicWarnings };
}
// ---- ІКОНКИ SVG для матеріалів ----
function _getMatIconSvg(name) {
    const n = name.toLowerCase();
    if (n.includes('фанера') || n.includes('акрил'))
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11.5L12 6l10 5.5-10 5.5L2 11.5z"/><path d="M2 16.5L12 22l10-5.5"/></svg>';
    if (n.includes('картон') || n.includes('коробка'))
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/></svg>';
    if (n.includes('скотч') || n.includes('стрічка'))
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 4v4"/></svg>';
    if (n.includes("м'яка") || n.includes('поролон'))
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/><circle cx="10" cy="14" r="1" fill="currentColor"/><circle cx="16" cy="16" r="1" fill="currentColor"/></svg>';
    if (n.includes('клей'))
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>';
    if (n.includes('серветки'))
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="12" y1="4" x2="12" y2="20"/></svg>';
    if (n.includes('стрейч'))
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="18" y1="6" x2="18" y2="18"/></svg>';
    if (n.includes('наждачка'))
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01" stroke-width="2.5"/></svg>';
    // фарба-кружок
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>';
}
function _getMatIconStyle(name, colorHex) {
    if (colorHex) return { bg: colorHex + '22', color: (colorHex === '#ffffff' || colorHex === '#f9f9fb') ? '#888' : colorHex };
    if (typeof getIconStyleForMaterial === 'function') {
        const s = getIconStyleForMaterial(name);
        return { bg: s.bg, color: s.color };
    }
    return { bg: '#f3f4f6', color: '#6b7280' };
}
// ---- POPOVER ----
function showMatWarnPopover(e, warnings, orderName) {
    e.stopPropagation();
    const pop = document.getElementById('matWarnPopover');
    if (!pop) return;
    const body = document.getElementById('mwpBody');
    const sub  = document.getElementById('mwpSub');
    if (sub) sub.textContent = orderName || 'Для цього замовлення';
    const colorHexMap = new Map([
        ...(window.kopilkaColors||[]).map(c=>[c.name, c.hex]),
        ...(window.hwColors||[]).map(c=>[c.name, c.hex]),
        ...(window.wtColors||[]).map(c=>[c.name, c.hex]),
    ]);
    body.innerHTML = warnings.map(w => {
        const hex = colorHexMap.get(w.name);
        const iStyle = _getMatIconStyle(w.name, hex);
        const qtyClass = w.isEmpty ? 'empty' : 'low';
        const qtyLabel = w.isEmpty ? '0 ' + w.unit : w.qty + ' ' + w.unit;
        const minLabel = w.threshold > 0 ? ' / мін ' + w.threshold + ' ' + w.unit : '';
        return `<div class="mwp-row">
            <div class="mwp-row-icon" style="background:${iStyle.bg}; color:${iStyle.color};">${_getMatIconSvg(w.name)}</div>
            <div class="mwp-row-name" title="${w.name}">${w.name}</div>
            <div class="mwp-row-qty ${qtyClass}">${qtyLabel}${minLabel}</div>
        </div>`;
    }).join('');
    // Позиціонування
    const rect = e.currentTarget.getBoundingClientRect();
    const vW = window.innerWidth, vH = window.innerHeight;
    const pW = 280;
    let top  = rect.bottom + 8;
    let left = rect.left - pW / 2 + rect.width / 2;
    if (left + pW > vW - 10) left = vW - pW - 10;
    if (left < 10) left = 10;
    if (top + 300 > vH - 10) top = rect.top - 300 - 8;
    pop.style.top  = top + 'px';
    pop.style.left = left + 'px';
    pop.classList.add('visible');
    setTimeout(() => {
        document.addEventListener('click', function _c(ev) {
            if (!pop.contains(ev.target)) { pop.classList.remove('visible'); }
            document.removeEventListener('click', _c);
        });
    }, 10);
}
window.closeMatWarnPopover = function() {
    const pop = document.getElementById('matWarnPopover');
    if (pop) pop.classList.remove('visible');
};
// ---- ГОЛОВНА ФУНКЦІЯ ----
window.applyMaterialWarningsToRow = function(row) {
    row.querySelectorAll('.mat-warn-left, .mwl-color-warn').forEach(el => el.remove());
    row.classList.remove('has-mat-warn');
    const { colorWarnings, basicWarnings } = getMaterialWarningsForRow(row);
    if (!colorWarnings.length && !basicWarnings.length) return;
    row.classList.add('has-mat-warn');
    const orderName = row.querySelector('td[data-type="product"]')?.dataset?.val || '';
    // ---- 1. КОЛОНКА "КОЛІР": ⚠ вставляємо прямо в multi-val-row перед badge ----
    if (colorWarnings.length) {
        const colorCell = row.querySelector('td[data-type="color"]');
        if (colorCell) {
            const warnNames = new Set(colorWarnings.map(w => w.name));
            const getColorName = (badge) => {
                const spans = badge.querySelectorAll('span');
                return spans.length > 1 ? spans[spans.length - 1].textContent.trim()
                                        : badge.textContent.trim();
            };
            const makePill = (warn) => {
                const pill = document.createElement('span');
                pill.className = 'mwl-color-warn' + (warn.isEmpty ? ' empty' : '');
                pill.innerHTML = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
                pill.addEventListener('click', e => { e.stopPropagation(); showMatWarnPopover(e, [warn], orderName); });
                return pill;
            };
            // multi-color: кожен рядок окремо
            const multiRows = colorCell.querySelectorAll('.multi-val-row');
            if (multiRows.length) {
                // Кілька кольорів: multi-val-row вже flex-row — просто вставляємо перед badge
                multiRows.forEach(valRow => {
                    const badge = valRow.querySelector('.badge');
                    if (!badge) return;
                    const colorName = getColorName(badge);
                    if (!warnNames.has(colorName)) return;
                    const warn = colorWarnings.find(w => w.name === colorName);
                    valRow.insertBefore(makePill(warn), badge);
                });
            } else {
                // Один колір: badge прямо в multi-wrapper (flex-direction:column)
                // Міняємо wrapper на row щоб pill і badge були в один рядок
                const badge = colorCell.querySelector('.badge');
                if (badge) {
                    const colorName = getColorName(badge);
                    if (warnNames.has(colorName)) {
                        const warn = colorWarnings.find(w => w.name === colorName);
                        const wrapper = badge.closest('.multi-wrapper');
                        if (wrapper) {
                            wrapper.style.flexDirection = 'row';
                            wrapper.style.alignItems = 'center';
                            wrapper.style.justifyContent = 'center';
                        }
                        badge.parentNode.insertBefore(makePill(warn), badge);
                    }
                }
            }
        }
    }
    // ---- 2. ЗЛІВА: іконка матеріалів ----
    if (basicWarnings.length) {
        const checkCell = row.querySelector('.cell-checkbox');
        if (!checkCell) return;
        checkCell.style.position = 'relative';
        const wrap = document.createElement('div');
        wrap.className = 'mat-warn-left';
        // JS hover: додаємо клас до <tr> щоб скасувати ховер через CSS
        wrap.addEventListener('mouseenter', () => row.classList.add('mat-icon-hover'));
        wrap.addEventListener('mouseleave', () => row.classList.remove('mat-icon-hover'));
        const firstMat = basicWarnings[0];
        const iStyle = _getMatIconStyle(firstMat.name, null);
        const hasEmpty = basicWarnings.some(w => w.isEmpty);
        const ic = document.createElement('div');
        ic.className = 'mwl-icon' + (hasEmpty ? ' empty' : '');
        ic.style.cssText = `background:${iStyle.bg}; color:${iStyle.color}; position:relative;`;
        ic.innerHTML = _getMatIconSvg(firstMat.name);
        if (basicWarnings.length > 1) {
            const badge = document.createElement('span');
            badge.className = 'mwl-badge';
            badge.textContent = basicWarnings.length;
            ic.appendChild(badge);
        }
        ic.addEventListener('click', e => { e.stopPropagation(); showMatWarnPopover(e, basicWarnings, orderName); });
        wrap.appendChild(ic);
        checkCell.appendChild(wrap);
    }
};
function updateAllMaterialWarnings() {
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach(row => window.applyMaterialWarningsToRow(row));
}
function getIconStyleForMaterial(name) {
    const n = name.toLowerCase();
    if (n.includes('фанера')) return { bg: '#fbf3db', color: '#8d6e63', svg: `<svg viewBox="0 0 24 24" style="width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round;"><path d="M2 11.5L12 6l10 5.5-10 5.5L2 11.5z"></path><path d="M2 16.5L12 22l10-5.5"></path></svg>` };
    if (n.includes('акрил')) return { bg: '#d3e5ef', color: '#0288d1', svg: `<svg viewBox="0 0 24 24" style="width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round;"><path d="M2 11.5L12 6l10 5.5-10 5.5L2 11.5z"></path><path d="M2 16.5L12 22l10-5.5"></path></svg>` };
    if (n.includes('картон') || n.includes('коробка')) return { bg: '#fdecc8', color: '#f57c00', svg: `<svg viewBox="0 0 24 24" style="width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.29 7 12 12 20.71 7"></polyline><line x1="12" y1="22" x2="12" y2="12"></line></svg>` };
    if (n.includes('скотч') || n.includes('стрічка')) return { bg: '#ffdad6', color: '#e53935', svg: `<svg viewBox="0 0 24 24" style="width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round;"><circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="3"></circle><path d="M12 4v4"></path></svg>` };
    if (n.includes('м\'яка') || n.includes('поролон')) return { bg: '#f4dfeb', color: '#8e24aa', svg: `<svg viewBox="0 0 24 24" style="width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round;"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><circle cx="8" cy="8" r="1" fill="currentColor"></circle><circle cx="15" cy="10" r="1" fill="currentColor"></circle><circle cx="10" cy="14" r="1" fill="currentColor"></circle><circle cx="16" cy="16" r="1" fill="currentColor"></circle></svg>` };
    
    // Новые иконки
    if (n.includes('серветки')) return { bg: '#f1f5f9', color: '#64748b', svg: `<svg viewBox="0 0 24 24" style="width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round;"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><line x1="4" y1="12" x2="20" y2="12"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>` };
    if (n.includes('клей')) return { bg: '#fef08a', color: '#ca8a04', svg: `<svg viewBox="0 0 24 24" style="width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round;"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path></svg>` };
    if (n.includes('стрейч')) return { bg: '#e0e7ff', color: '#4f46e5', svg: `<svg viewBox="0 0 24 24" style="width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round;"><rect x="2" y="6" width="20" height="12" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6" y2="18"></line><line x1="18" y1="6" x2="18" y2="18"></line></svg>` };
    
    // --- ИКОНКА ДЛЯ НАЖДАЧКИ ---
    if (n.includes('наждачка')) return { bg: '#f3f4f6', color: '#475569', svg: `<svg viewBox="0 0 24 24" style="width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round;"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><path d="M9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01" stroke-width="2.5" stroke-linecap="round"></path></svg>` };
    return { bg: '#dbeede', color: '#2e7d32', svg: `<svg viewBox="0 0 24 24" style="width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round;"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>` };
}
function getColorShades(hex) {
    if (!hex || hex === '#ffffff') return { circleBg: '#ffffff', pillBg: '#f9f9fb', border: '#e5e7eb', text: '#374151', valColor: '#111827' };
    let h = hex.length === 4 ? '#' + hex[1]+hex[1] + hex[2]+hex[2] + hex[3]+hex[3] : hex;
    const r = parseInt(h.slice(1,3), 16); const g = parseInt(h.slice(3,5), 16); const b = parseInt(h.slice(5,7), 16);
    const circleBg = `rgb(${r}, ${g}, ${b})`;
    const bgR = Math.round(r * 0.08 + 255 * 0.92); const bgG = Math.round(g * 0.08 + 255 * 0.92); const bgB = Math.round(b * 0.08 + 255 * 0.92);
    const pillBg = `rgb(${bgR}, ${bgG}, ${bgB})`;
    const brR = Math.round(r * 0.18 + 255 * 0.82); const brG = Math.round(g * 0.18 + 255 * 0.82); const brB = Math.round(b * 0.18 + 255 * 0.82);
    const border = `rgb(${brR}, ${brG}, ${brB})`;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const text = luma > 150 ? 'rgba(0,0,0,0.7)' : '#ffffff';
    const valColor = `rgb(${Math.round(r * 0.3)}, ${Math.round(g * 0.3)}, ${Math.round(b * 0.3)})`;
    return { circleBg, pillBg, border, text, valColor };
}
function renderMaterialsTable() {
    const dash = document.getElementById('materialsDashboard');
    if (!dash) return;
    const allColorsMap = new Map();
    if(window.kopilkaColors) window.kopilkaColors.forEach(c => allColorsMap.set(c.name, c.hex));
    if(window.hwColors) window.hwColors.forEach(c => allColorsMap.set(c.name, c.hex));
    const colorNames = Array.from(allColorsMap.keys());
    let displayPaints = [];
    let displayBasics = [];
    const baseNames = ['Фанера 4мм', 'Акрил', 'Картон', 'М\'яка частина', 'Скотч'];
    
    materialsData.forEach(m => {
        if (m.isHidden) return;
        const isColor = colorNames.includes(m.name) || (m.id && m.id.startsWith('color_'));
        if (isColor) displayPaints.push(m);
        else displayBasics.push(m);
    });
    Array.from(allColorsMap.entries()).forEach(([name, hex]) => {
        if (!displayPaints.some(m => m.name === name) && !materialsData.some(m => m.name === name && m.isHidden)) {
            displayPaints.push({ id: 'color_' + name, name: name, unit: 'мл', qty: 0, rules: [] });
        }
    });
    baseNames.forEach(bn => {
        if (!displayBasics.some(m => m.name === bn) && !materialsData.some(m => m.name === bn && m.isHidden)) {
            displayBasics.push({ id: 'base_' + bn, name: bn, unit: 'шт', qty: 0, rules: [] });
        }
    });
    let html = `
    <style>
        #materialsDashboard * { font-family: 'Inter', sans-serif !important; }
        .figma-section-title { font-size: 16px; font-weight: 600; color: var(--c-texSec); margin: 0; padding-left: 4px; }
        .figma-paint-grid, .figma-mats-grid { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 56px; }
        @keyframes popIn { 0% { transform: translateY(15px) scale(0.98); opacity: 0; } 100% { transform: translateY(0) scale(1); opacity: 1; } }
        .f-paint-card { display: flex; align-items: center; justify-content: space-between; border: 1px solid; border-radius: 28px; padding: 8px 18px 8px 8px; gap: 16px; cursor: grab; transition: transform 0.2s ease, box-shadow 0.2s ease; height: 72px; box-sizing: border-box; width: auto; min-width: 145px; opacity: 0; animation: popIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; position: relative; }
        .f-paint-card:active { cursor: grabbing; }
        .f-paint-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
        .f-paint-card.is-empty { opacity: 1; filter: grayscale(0.5); border-style: dashed !important; }
        
        /* ФІКС: Повернуто тонку, м'яку обводку 1px rgba(255,255,255,0.2) */
        .f-paint-circle { width: 54px; height: 54px; min-width: 54px; min-height: 54px; flex-shrink: 0; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 800; text-align: center; line-height: 1.15; padding: 6px; box-sizing: border-box; border: 1px solid rgba(255,255,255,0.2); box-shadow: 0 2px 6px rgba(0,0,0,0.05); }
        .f-paint-circle-inner { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; width: 100%; word-wrap: break-word; }
        
        .f-paint-val { display:flex; align-items:center; justify-content: flex-end; gap: 8px; flex: 1;}
        .f-paint-val .val-text { font-size: 22px; font-weight: 700; display:flex; align-items:baseline; gap:4px; line-height:1; letter-spacing: -1px; opacity: 0.85; margin-bottom: -2px;}
        .f-paint-val span { font-size: 14px; font-weight: 600; opacity: 0.7; letter-spacing: normal; }
        .f-mat-card { background: white; border: 1px solid var(--ca-borSecTra); border-radius: 28px; padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.02); display: flex; flex-direction: column; cursor: grab; transition: transform 0.2s ease, box-shadow 0.2s ease; opacity: 0; animation: popIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; min-width: 210px; flex: 1; max-width: 260px; position: relative; }
        .f-mat-card:active { cursor: grabbing; }
        .f-mat-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.05); border-color: #d1d1d1; }
        .f-mat-card.is-empty { opacity: 0.5; filter: grayscale(0.5); border-style: dashed; }
        .f-mat-icon { width: 44px; height: 44px; border-radius: 50%; display:flex; align-items:center; justify-content:center; margin-bottom: 24px;}
        .f-mat-title { font-size: 14px; color: var(--c-texSec); margin-bottom: 12px; font-weight: 500; }
        
        .f-mat-val { display:flex; align-items:center; gap:12px; margin-top: auto;}
        .f-mat-val .val-text { font-size: 40px; font-weight: 800; color: #111827; display:flex; align-items:baseline; gap:6px; line-height: 1; letter-spacing: -1.5px;}
        .f-mat-val span { font-size: 16px; font-weight: 600; color: #9ca3af; letter-spacing: normal;}
        .f-add-inline { display: flex; align-items: center; justify-content: center; border: 2px dashed #e5e7eb !important; background: transparent !important; border-radius: 28px; cursor: pointer; transition: all 0.2s ease; box-shadow: none !important; opacity: 1; animation: none; color: #9ca3af; }
        .f-add-inline:hover { border-color: #111827 !important; background: rgba(17, 24, 39, 0.02) !important; color: #111827; }
        .f-add-mat { min-width: 210px; flex: 1; max-width: 260px; min-height: 160px; }
        .sortable-ghost { opacity: 0.3; background: #f9f9fb; border-style: dashed; }
        .sortable-drag { cursor: grabbing !important; }
        .f-mat-actions { position: absolute; top: 16px; right: 16px; display: flex; gap: 6px; opacity: 0; transform: translateY(-4px); transition: all 0.2s ease; z-index: 10; }
        .f-mat-card:hover .f-mat-actions { opacity: 1; transform: translateY(0); }
        .f-mat-action-btn { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #9ca3af; transition: 0.2s; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
        .f-mat-action-btn:hover { background: #f9f9fb; color: #111827; border-color: #d1d5db; transform: translateY(-1px); }
        .f-mat-action-btn.delete-btn:hover { color: #ef4444; background: #fef2f2; border-color: #fca5a5; }
        .quick-add-btn { background: rgba(17, 24, 39, 0.04); border: 1px solid rgba(17, 24, 39, 0.08); border-radius: 8px; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #6B7280; transition: all 0.2s ease; opacity: 0; transform: scale(0.9); flex-shrink: 0; margin-left: auto; }
        .f-paint-card:hover .quick-add-btn, .f-mat-card:hover .quick-add-btn { opacity: 1; transform: scale(1); }
        .quick-add-btn:hover { background: #111827; color: white; border-color: #111827; }
    </style>
    <div style="padding: 10px 0 20px 0;">
        <div class="figma-section-title" style="margin-bottom: 24px;">Фарба</div>
        <div class="figma-paint-grid" id="paintGrid">
`;
    let delay = 0; 
    displayPaints.forEach(mat => {
        const hex = allColorsMap.get(mat.name) || '#ffffff';
        const qty = mat.qty || 0; 
        const isEmpty = qty <= 0;
        const isLow = !isEmpty && mat.threshold !== undefined && mat.threshold > 0 && qty <= mat.threshold;
        const liters = isEmpty ? '0' : (qty / 1000).toFixed(1).replace(/\.0$/, '');
        const shades = typeof getColorShades === 'function' ? getColorShades(hex) : { pillBg: '#f3f4f6', border: '#e5e7eb', text: '#111827', circleBg: hex, valColor: '#111827' };
        const cardBorder = (isEmpty || isLow) ? '#fed7aa' : shades.border;
        const cardBg = (isEmpty || isLow) ? '#fff7ed' : shades.pillBg;
        html += `
            <div class="f-paint-card ${isEmpty ? 'is-empty' : ''} sortable-item" data-id="${mat.id}" style="background: ${cardBg}; border-color: ${cardBorder}; animation-delay: ${delay}ms;" onclick="openEditModal('${mat.name.replace(/'/g, "\\'")}', 'мл', true, '${mat.id}')">
                <div class="f-paint-circle" style="background: ${shades.circleBg}; color: ${shades.text};">
                    <div class="f-paint-circle-inner">${mat.name}</div>
                </div>
                <div class="f-paint-val" style="color: ${shades.valColor};">
                    <div class="val-text">${liters}<span>л</span></div>
                    ${(isEmpty || isLow) ? `<span title="${isEmpty ? 'Немає фарби' : 'Мало фарби (мін: ' + (mat.threshold/1000).toFixed(1) + ' л)'}" style="font-size:14px;opacity:0.9;margin-right:2px;">⚠️</span>` : ''}
                    <button class="quick-add-btn ignore-drag" onclick="openQuickAdd(event, '${mat.id}', '${mat.name.replace(/'/g, "\\'")}', true)" title="Додати кількість">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    </button>
                </div>
            </div>`;
        delay += 25; 
    });
    html += `</div>
        <div class="f-add-inline f-paint-add-btn ignore-drag" onclick="window.openAddColorModal()" title="Додати новий колір" style="display:inline-flex;align-items:center;justify-content:center;width:72px;height:72px;border-radius:50%;margin-top:0;cursor:pointer;border:2px dashed #e5e7eb;color:#9ca3af;transition:0.2s;flex-shrink:0;" onmouseover="this.style.borderColor='#111827';this.style.color='#111827'" onmouseout="this.style.borderColor='#e5e7eb';this.style.color='#9ca3af'">
            <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2.5" fill="none"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </div>
    
    <div class="figma-section-title" style="margin-bottom: 24px;">Основні матеріали</div>
    <div class="figma-mats-grid" id="basicGrid">`;
    displayBasics.forEach(mat => {
        const isEmpty = mat.qty <= 0;
        const isLow = !isEmpty && mat.threshold !== undefined && mat.threshold > 0 && (parseFloat(mat.qty) || 0) <= mat.threshold;
        const style = getIconStyleForMaterial(mat.name);
        let displayUnit = mat.unit === 'м2' ? 'м&sup2;' : mat.unit;
        const cardStyle = (isEmpty || isLow) ? 'border: 1.5px solid #fed7aa !important; background: #fff7ed !important;' : '';
        
        html += `
            <div class="f-mat-card ${isEmpty ? 'is-empty' : ''} sortable-item" data-id="${mat.id}" style="animation-delay: ${delay}ms; ${cardStyle}">
                <div class="f-mat-actions ignore-drag">
                    <button class="f-mat-action-btn edit-btn" onclick="openEditDirectly(event, '${mat.name.replace(/'/g, "\\'")}', '${mat.unit}', '${mat.id}')" title="Редагувати">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button class="f-mat-action-btn delete-btn" onclick="deleteMaterialQuick(event, '${mat.id}')" title="Видалити">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                    </button>
                </div>
                <div style="flex-grow: 1; cursor: pointer; display: flex; flex-direction: column;" onclick="openEditModal('${mat.name.replace(/'/g, "\\'")}', '${mat.unit}', false, '${mat.id}')">
                    <div class="f-mat-icon" style="background:${style.bg}; color:${style.color};">${style.svg}</div>
                    <div class="f-mat-title">${mat.name}${(isEmpty || isLow) ? ' ⚠️' : ''}</div>
                    <div class="f-mat-val">
                        <div class="val-text">${isEmpty ? '0' : mat.qty} <span>${displayUnit}</span></div>
                        <button class="quick-add-btn ignore-drag" onclick="openQuickAdd(event, '${mat.id}', '${mat.name.replace(/'/g, "\\'")}', false)" title="Додати кількість">
                            <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        </button>
                    </div>
                </div>
            </div>`;
        delay += 25;
    });
    html += `
        <div class="f-mat-card f-add-inline f-add-mat ignore-drag" onclick="openMaterialModal()" title="Додати новий матеріал">
            <svg viewBox="0 0 24 24" width="36" height="36" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"></path></svg>
        </div>
    </div>`;
    html += `</div></div>`;
    
    dash.innerHTML = html;
    setTimeout(() => {
        const paintEl = document.getElementById('paintGrid');
        const basicEl = document.getElementById('basicGrid');
        if (paintEl && typeof Sortable !== 'undefined') {
            new Sortable(paintEl, { animation: 150, filter: '.ignore-drag', draggable: '.sortable-item', ghostClass: 'sortable-ghost', onEnd: saveMaterialsOrder });
        }
        if (basicEl && typeof Sortable !== 'undefined') {
            new Sortable(basicEl, { animation: 150, filter: '.ignore-drag', draggable: '.sortable-item', ghostClass: 'sortable-ghost', onEnd: saveMaterialsOrder });
        }
    }, 100);
}
// ФУНКЦИЯ ДЛЯ СОХРАНЕНИЯ НОВОГО ПОРЯДКА В FIREBASE
function saveMaterialsOrder() {
    if (userRole === 'limited') return; // Защита от изменений ограниченным пользователем
    const paintGrid = document.getElementById('paintGrid');
    const basicGrid = document.getElementById('basicGrid');
    if (!paintGrid || !basicGrid) return;
    // Собираем ID в новом порядке
    const paintIds = Array.from(paintGrid.querySelectorAll('.sortable-item')).map(el => el.dataset.id);
    const basicIds = Array.from(basicGrid.querySelectorAll('.sortable-item')).map(el => el.dataset.id);
    const newOrderIds = [...paintIds, ...basicIds];
    // Формируем новый массив материалов
    let reorderedMaterials = [];
    
    // Сначала пушим те, что мы видим в новом порядке
    newOrderIds.forEach(id => {
        const mat = materialsData.find(m => m.id === id);
        if (mat) reorderedMaterials.push(mat);
    });
    // Затем добавляем скрытые (isHidden) или те, которые по какой-то причине не попали в DOM
    materialsData.forEach(mat => {
        if (!reorderedMaterials.some(m => m.id === mat.id)) {
            reorderedMaterials.push(mat);
        }
    });
    // Обновляем локальную переменную и отправляем в Firebase
    materialsData = reorderedMaterials;
    db.collection("babak_crm").doc("materials_state").set({ items: materialsData })
        .catch(err => console.error("Помилка збереження порядку:", err));
}
// --- ЛОГІКА ДЛЯ КАСТОМНОГО ДРОПДАУНУ ОДИНИЦЬ ВИМІРУ ---
window.setMatUnit = function(val, e) {
    if(e) e.stopPropagation();
    document.getElementById('matUnit').value = val;
    document.getElementById('matUnitSelectedText').innerText = val;
    document.querySelectorAll('#matUnitList .dropdown-option').forEach(el => { el.classList.toggle('active', el.innerText.trim() === val); });
    const dropdown = document.getElementById('matUnitDropdown');
    if(dropdown) dropdown.classList.remove('open');
}
window.openMaterialModal = function() {
    // Примусово розширюємо вікно, щоб помістилися всі колонки
    document.querySelector('#materialModal .mac-modal').style.width = '920px';
    document.querySelector('#materialModal .mac-modal').style.maxWidth = '95vw';
    
    document.getElementById('materialModalTitle').innerText = 'Додати нову позицію';
    document.getElementById('matId').value = '';
    document.getElementById('matName').value = '';
    document.getElementById('matName').readOnly = false; 
    document.getElementById('matQty').value = '';
    document.getElementById('matPrice').value = '';
    document.getElementById('matThreshold').value = '';
    setMatUnit('шт');
    currentEditingRules = [];
    renderRulesList();
    const overlay = document.getElementById('materialModal');
    if (overlay) overlay.classList.add('active');
}
window.openEditModal = function(name, unit, isColor, customId = null) {
    document.querySelector('#materialModal .mac-modal').style.width = '920px';
    document.querySelector('#materialModal .mac-modal').style.maxWidth = '95vw';
    
    const found = materialsData.find(m => m.id === customId || m.name === name);
    const actualId = found ? found.id : (customId || 'mat_' + Date.now());
    const actualName = found ? found.name : name;
    
    document.getElementById('materialModalTitle').innerText = `Налаштування`;
    document.getElementById('matId').value = actualId;
    document.getElementById('matName').value = actualName;
    document.getElementById('matName').readOnly = false; 
    document.getElementById('matQty').value = found ? found.qty : '';
    document.getElementById('matPrice').value = found && found.price ? found.price : '';
    document.getElementById('matThreshold').value = found && found.threshold ? found.threshold : '';
    setMatUnit(found ? found.unit : unit);
    
    currentEditingRules = found && found.rules ? JSON.parse(JSON.stringify(found.rules)) : [];
    renderRulesList();
    
    const overlay = document.getElementById('materialModal');
    if (overlay) overlay.classList.add('active');
}
window.closeMaterialModal = function() {
    const overlay = document.getElementById('materialModal');
    if (overlay) overlay.classList.remove('active');
}
// --- УМНАЯ АВТО-ГРУППИРОВКА И ПРЕМІАЛЬНІ ДРОПДАУНИ (ІНДИВІДУАЛЬНІ) ---
window.collapsedRuleGroups = new Set(); 
window.toggleRuleGroup = function(groupKey) {
    if (window.collapsedRuleGroups.has(groupKey)) { window.collapsedRuleGroups.delete(groupKey); } 
    else { window.collapsedRuleGroups.add(groupKey); }
    window.renderRulesList();
};
window.renderRulesList = function() {
    const container = document.getElementById('rulesContainer');
    if (!container) return;
    const matName = document.getElementById('matName')?.value?.trim();
    if (!matName) {
        container.innerHTML = '<div style="text-align:center;padding:16px;color:#9ca3af;font-size:13px;">Збережіть матеріал, щоб побачити рецепти</div>';
        return;
    }
    // Збираємо всі правила де цей матеріал використовується
    const found = materialsData.find(m => m.name === matName);
    const rules = (found && found.rules) ? found.rules.filter(r => (parseFloat(r.amount) || 0) > 0) : [];
    if (rules.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:16px;color:#9ca3af;font-size:13px;border:1px dashed #e5e7eb;border-radius:12px;">Цей матеріал ще не доданий до жодного рецепту товару</div>';
        return;
    }
    // Групуємо по товар+розмір+колір
    const groups = {};
    rules.forEach(r => {
        const prod = r.product || 'all';
        const size = r.size || 'all';
        const color = r.productColor || 'all';
        const key = `${prod}|${size}|${color}`;
        if (!groups[key]) groups[key] = { prod, size, color, amount: 0 };
        groups[key].amount += parseFloat(r.amount) || 0;
    });
    const allColorsMap = {};
    [...(window.kopilkaColors||[]), ...(window.hwColors||[])].forEach(c => allColorsMap[c.name] = c.hex);
    let html = '';
    Object.values(groups).forEach(g => {
        const sizeBadge = g.size !== 'all' ? `<span style="background:#f3f4f6;border:1px solid #e5e7eb;color:#374151;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;margin-left:6px;">${g.size}</span>` : '';
        let colorBadge = '';
        if (g.color !== 'all' && allColorsMap[g.color]) {
            colorBadge = `<span style="background:white;border:1px solid #d1d1d1;color:#374151;font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;margin-left:6px;display:inline-flex;align-items:center;gap:4px;"><span style="width:9px;height:9px;border-radius:50%;background:${allColorsMap[g.color]};border:1px solid rgba(0,0,0,0.1);display:inline-block;"></span>${g.color}</span>`;
        }
        const prodLabel = g.prod === 'all' ? 'Будь-який товар' : g.prod;
        const unit = found?.unit || '';
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border:1px solid #f3f4f6;border-radius:12px;margin-bottom:8px;background:#fafafa;">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;">
                <span style="font-size:13px;font-weight:700;color:#111827;">${prodLabel}</span>
                ${sizeBadge}${colorBadge}
            </div>
            <span style="font-size:13px;font-weight:800;color:#374151;white-space:nowrap;margin-left:12px;">${g.amount % 1 === 0 ? g.amount : g.amount.toFixed(2)} ${unit}</span>
        </div>`;
    });
    container.innerHTML = html;
};
window.addRuleRow = function() { 
    currentEditingRules.push({ product: 'all', size: 'all', productColor: 'all', amount: '' }); 
    if(window.collapsedRuleGroups) window.collapsedRuleGroups.delete('Будь-який товар|Будь-який розмір|Будь-який колір');
    renderRulesList(); 
}
window.addRuleToGroup = function(pVal, sVal, cVal) {
    currentEditingRules.push({ product: pVal, size: sVal, productColor: cVal, amount: '' });
    renderRulesList();
}
window.updateRule = function(idx, field, value) { 
    currentEditingRules[idx][field] = value; 
    if (field !== 'amount') renderRulesList(); 
}
window.deleteRuleRow = function(idx) { currentEditingRules.splice(idx, 1); renderRulesList(); }
window.saveMaterial = function() {
    if (userRole === 'limited') { alert('Тільки адміністратор може змінювати склад'); return; }
    
    let id = document.getElementById('matId').value;
    const name = document.getElementById('matName').value.trim();
    const unit = document.getElementById('matUnit').value;
    const qty = parseFloat(document.getElementById('matQty').value) || 0;
    const price = parseFloat(document.getElementById('matPrice').value) || 0;
    const threshold = parseFloat(document.getElementById('matThreshold').value) || 0;
    if (!name) { alert('Введіть назву!'); return; }
    if (!id) { id = 'mat_' + Date.now(); }
    const cleanRules = currentEditingRules.map(r => {
        let isHw = (r.product || 'all').toLowerCase().includes('хот') || (r.product || 'all').toLowerCase().includes('hot');
        let amt = parseFloat(r.amount);
        return { 
            product: r.product || 'all', 
            size: r.size || 'all', 
            productColor: isHw ? (r.productColor || 'all') : 'all',
            // Якщо поле пусте (NaN), ставимо -1 щоб потім відфільтрувати. Інакше залишаємо введене число (навіть 0).
            amount: isNaN(amt) ? -1 : amt 
        };
    }).filter(r => r.amount >= 0); // ФІКС: тепер >= 0 (нуль зберігається)
    
    const existingIndex = materialsData.findIndex(m => m.id === id); 
    
  if (existingIndex >= 0) { 
        materialsData[existingIndex] = { id, name, unit, qty, price, threshold, rules: cleanRules, isHidden: false }; 
    } else { 
        materialsData.push({ id, name, unit, qty, price, threshold, rules: cleanRules, isHidden: false }); 
    }
    db.collection("babak_crm").doc("materials_state").set({ items: materialsData })
        .then(() => { showToast('Склад оновлено'); closeMaterialModal(); })
        .catch(e => console.error(e));
}
// --- ВИДАЛЕННЯ БУДЬ-ЯКОЇ ПОЗИЦІЇ (Софт-деліт) ---
window.deleteMaterialFromModal = function() {
    if (userRole === 'limited') { alert('Тільки адміністратор може видаляти'); return; }
    const id = document.getElementById('matId').value;
    const name = document.getElementById('matName').value;
    
    if(confirm('Видалити цю позицію назавжди? Вона зникне зі складу.')) {
        const existingIndex = materialsData.findIndex(m => m.id === id || m.name === name);
        if (existingIndex >= 0) {
            materialsData[existingIndex].isHidden = true; // Ховаємо, щоб не відображалось
            materialsData[existingIndex].qty = 0;
        } else {
            materialsData.push({ id, name, unit: 'шт', qty: 0, rules: [], isHidden: true });
        }
        
        db.collection("babak_crm").doc("materials_state").set({ items: materialsData })
            .then(() => { showToast('Позицію видалено'); closeMaterialModal(); });
    }
}
// ==========================================
// ВІДНОВЛЕНА ЛОГІКА КОНТЕКСТНОГО МЕНЮ, ЧАТУ ТА ІСТОРІЇ
// ==========================================
let contextMenuTarget = null;
let contextMenuCoords = null;
// Виклик контекстного меню (правий клік)
const tableBody = document.getElementById('tableBody');
if (tableBody) {
    tableBody.addEventListener('contextmenu', (e) => {
        const td = e.target.closest('td');
        if (!td || td.classList.contains('cell-checkbox') || td.classList.contains('no-print')) return;
        e.preventDefault(); 
        if (e.target.closest('.comment-pin')) return; 
        closeAllPopovers(); 
        const rect = td.getBoundingClientRect();
        contextMenuTarget = td;
        contextMenuCoords = { x: e.clientX, y: e.clientY, relX: e.clientX - rect.left, relY: e.clientY - rect.top };
        const menu = document.getElementById('rowContextMenu');
        const fakeRect = { top: e.clientY, bottom: e.clientY, left: e.clientX, right: e.clientX };
        window.smartPosition(menu, fakeRect, 'bottom');
    });
}
// Обробка кнопок у контекстному меню
window.handleContextMenuAction = function(action) {
    hidePopover(document.getElementById('rowContextMenu'));
    if (!contextMenuTarget) return;
    if (action === 'comment') {
        pendingCommentCoords = { td: contextMenuTarget, x: contextMenuCoords.relX, y: contextMenuCoords.relY };
        openChatPopover(null, contextMenuCoords.x, contextMenuCoords.y);
    } else if (action === 'details') {
        openOrderDetailsModal(contextMenuTarget.closest('tr'));
    } else if (action === 'shipping') {
        openShippingModal(contextMenuTarget.closest('tr'));
    }
}
// --- ЛОГІКА ДЛЯ ЧАТУ (КОМЕНТАРІВ) ---
window.openChatPopover = function(pin, clientX, clientY) {
    if(pin) closeAllPopovers(); 
    activeCommentPin = pin;
    const popover = document.getElementById('chatPopover');
    const fakeRect = { top: clientY, bottom: clientY + 15, left: clientX, right: clientX };
    window.smartPosition(popover, fakeRect, 'bottom');
    if (pin) {
        let readBy = []; try { readBy = JSON.parse(pin.dataset.readby || '[]'); } catch(e){}
        if (!readBy.includes(currentUser)) {
            readBy.push(currentUser); pin.dataset.readby = JSON.stringify(readBy);
            // Якщо у тебе є функція updateAllUnreadDots, вона спрацює
            if (typeof updateAllUnreadDots === 'function') updateAllUnreadDots(); 
            if (typeof saveData === 'function') saveData();
        }
        renderThread(pin);
    } else { 
        document.getElementById('chatMessages').innerHTML = '<div style="color:#9a9a97; font-size:13px; text-align:center; padding:10px;">Нове обговорення</div>'; 
    }
    setTimeout(() => document.getElementById('chatInput').focus(), 50);
}
window.renderThread = function(pin) {
    const msgs = JSON.parse(pin.dataset.thread || '[]');
    const container = document.getElementById('chatMessages');
    container.innerHTML = msgs.map(m => `<div class="chat-msg ${m.author === currentUser ? 'my-msg' : ''}"><div class="chat-msg-author">${m.author}</div><div class="chat-msg-text">${m.text.replace(/\n/g, '<br>')}</div></div>`).join('');
    container.scrollTop = container.scrollHeight;
}
window.sendComment = function() {
    const input = document.getElementById('chatInput'); const text = input.value.trim(); if (!text) return;
    const newMsg = { author: currentUser, text: text };
    
    if (typeof recordUndoState === 'function') recordUndoState();
    if (activeCommentPin) {
        let thread = JSON.parse(activeCommentPin.dataset.thread || '[]'); thread.push(newMsg);
        activeCommentPin.dataset.thread = JSON.stringify(thread); activeCommentPin.dataset.readby = JSON.stringify([currentUser]);
        renderThread(activeCommentPin);
    } else if (pendingCommentCoords) {
        const pin = document.createElement('div'); pin.className = 'comment-pin no-print';
        pin.style.left = `${pendingCommentCoords.x}px`; pin.style.top = `${pendingCommentCoords.y}px`;
        pin.dataset.thread = JSON.stringify([newMsg]); pin.dataset.readby = JSON.stringify([currentUser]);
        pin.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 5.8 2 10.5c0 2.76 1.54 5.2 4.09 6.84A8.7 8.7 0 0 1 4 21.64c-.15.22.08.49.33.4.92-.33 2.65-1.12 4.2-2.31A11.75 11.75 0 0 0 12 20c5.52 0 10-3.8 10-8.5S17.52 2 12 2z"/></svg><div class="unread-dot"></div>`;
        pendingCommentCoords.td.appendChild(pin); activeCommentPin = pin; pendingCommentCoords = null; renderThread(pin);
    }
    input.value = ''; 
    if (typeof updateAllUnreadDots === 'function') updateAllUnreadDots(); 
    if (typeof saveData === 'function') saveData();
}
window.deleteActiveThread = function() {
    if (userRole !== 'admin') { alert('Тільки адмін може видаляти обговорення.'); return; }
    if (activeCommentPin && confirm('Видалити це обговорення?')) { 
        if (typeof recordUndoState === 'function') recordUndoState(); 
        activeCommentPin.remove(); 
        closeAllPopovers(); 
        if (typeof saveData === 'function') saveData(); 
    }
}
// --- ЛОГІКА ДЛЯ ВІКНА ДЕТАЛЕЙ І ЧАСУ ---
window.openOrderDetailsModal = function(row) {
    const modal = document.getElementById('orderDetailsModal');
    const content = document.getElementById('orderDetailsContent');
    let history = [];
    try { history = JSON.parse(row.dataset.history || '[]'); } catch(e) {}
    if (history.length === 0) {
        content.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--c-texSec);">Історія статусів порожня.<br>Вона почне записуватись для всіх нових замовлень.</div>';
    } else {
        let html = '';
        for (let i = 0; i < history.length; i++) {
            const step = history[i];
            const dateStr = new Date(step.t).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            let stItem = menuData['status'] ? menuData['status'].find(s => s.text === step.s) : null;
            let badgeStyle = stItem && stItem.customStyle ? stItem.customStyle : 'background: white; border: 1px solid var(--ca-borSecTra); color: var(--c-texPri);';
            let badgeClass = stItem && stItem.class ? stItem.class : 'badge-status';
            let actionText = (i === 0 || step.isCreation) ? "Створено в таблиці:" : "Змінено на:";
            html += `<div style="margin-bottom: 8px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px;">
                        <strong style="font-size: 13px; color: var(--c-texPri);">${dateStr}</strong>
                        <span style="font-size: 12px; color: var(--c-texSec);">${actionText}</span>
                        <span class="badge ${badgeClass}" style="${badgeStyle} padding: 2px 8px; height: auto; min-height: 20px;">${step.s}</span>
                     </div>`;
            if (i < history.length - 1) {
                const diffMs = history[i+1].t - step.t;
                html += `<div style="font-size: 11px; color: var(--c-texTer); margin-left: 12px; border-left: 1px dashed var(--ca-borSecTra); padding: 6px 0 6px 14px; margin-bottom: 8px;">
                            ⏱ В цьому статусі замовлення було: <b>${formatTimeDiff(diffMs)}</b>
                         </div>`;
            } else {
                 const statusTextLower = step.s.toLowerCase();
                 if (statusTextLower === 'відправлено' || statusTextLower === 'done' || statusTextLower === 'зроблено') {
                     const totalDiff = step.t - history[0].t;
                     html += `<div style="font-size: 11px; color: #4b9a52; margin-left: 12px; padding: 6px 0 0 14px; margin-bottom: 8px;">
                                🎉 Загальний час виконання: <b>${formatTimeDiff(totalDiff)}</b>
                             </div>`;
                 } else {
                     const currentDiff = Date.now() - step.t;
                     html += `<div style="font-size: 11px; color: #2383e2; margin-left: 12px; padding: 6px 0 0 14px; margin-bottom: 8px;">
                                ⏳ Поточний статус триває: <b>${formatTimeDiff(currentDiff)}</b>
                             </div>`;
                 }
            }
        }
        content.innerHTML = html;
    }
    modal.classList.add('active');
}
window.closeOrderDetailsModal = function() { 
    document.getElementById('orderDetailsModal').classList.remove('active'); 
}
// ==========================================
// МОДАЛ ВІДПРАВКИ
// ==========================================
let _shippingRow = null;
// Рендер клітинки отримувача — стиснутий, розгортається при кліку через модал
window.renderRecipientCell = function(cell, val) {
    if (!val) { cell.innerHTML = '<div class="clamp-wrapper"></div>'; return; }
    const lines = val.split('\n').filter(Boolean);
    const name = lines[0] || '';
    const rest = lines.slice(1).join(' · ');
    cell.innerHTML = `<div class="clamp-wrapper recipient-preview" style="cursor:pointer;">
        <div style="font-weight:600;color:#111827;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
        ${rest ? `<div style="font-size:10px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;">${rest}</div>` : ''}
    </div>`;
};
// Ініціалізуємо recipient клітинки при завантаженні даних
window._initRecipientCells = function() {
    document.querySelectorAll('td[data-type="recipient"]').forEach(cell => {
        const val = cell.dataset.val || cell.innerText.trim();
        if (val && !cell.querySelector('.recipient-preview')) {
            window.renderRecipientCell(cell, val);
        }
    });
};
window.openShippingModal = function(row) {
    if (!row) return;
    _shippingRow = row;
    const get = (type) => (row.querySelector(`td[data-type="${type}"]`)?.dataset.val || row.querySelector(`td[data-type="${type}"]`)?.innerText || '').trim();
    const prod = get('product');
    const sizes = get('size').split(/\n|,/).map(s=>s.trim()).filter(Boolean);
    const colors = get('color').split(/\n|,/).map(s=>s.trim()).filter(Boolean);
    const recipientRaw = get('recipient');
    let infoText = prod;
    if (sizes.length) infoText += ' · ' + sizes.join(', ');
    if (colors.length) infoText += ' · ' + colors.join(', ');
    document.getElementById('shippingOrderInfo').textContent = infoText;
    // Парсимо адресу — розбиваємо по рядках
    const lines = recipientRaw.split(/\n/).map(l => l.trim()).filter(Boolean);
    document.getElementById('shipName').value    = lines[0] || '';
    document.getElementById('shipStreet').value  = lines[1] || '';
    document.getElementById('shipCity').value    = lines[2] || '';
    document.getElementById('shipCountry').value = lines[3] || '';
    // Email шукаємо по @ в будь-якому рядку, або з dataset рядка
    const emailLine = row.dataset.shipEmail || lines.find(l => l.includes('@')) || '';
    document.getElementById('shipEmail').value   = emailLine;
    // Телефон шукаємо по цифрах, або з dataset рядка
    const phoneLine = row.dataset.shipPhone || lines.find(l => !l.includes('@') && (l.replace(/\D/g,'').length >= 7)) || '';
    document.getElementById('shipPhone').value   = phoneLine;
    // Завантажуємо ціну/доставку конкретно цього рядка (зберігається як атрибут на <tr>)
    const savedPrice    = row.dataset.priceUsd    || '';
    const savedDelivery = row.dataset.deliveryUsd || '';
    // Якщо є збережені — підставляємо їх, інакше — порожньо
    document.getElementById('shippingPrice').value    = savedPrice;
    document.getElementById('shippingDelivery').value = savedDelivery;
    const updateRate = () => {
        const p = parseFloat(document.getElementById('shippingPrice').value) || 0;
        const d = parseFloat(document.getElementById('shippingDelivery').value) || 0;
        const rate = window._currentShippingRate || window._usdRate || 41;
        const rateEl = document.getElementById('shippingRateInfo');
        if (rateEl && (p > 0 || d > 0)) {
            const uah = ((p + d) * rate).toFixed(0);
            rateEl.textContent = `Курс: 1 $ = ${rate.toFixed(1)} ₴  ·  Разом ≈ ${uah} ₴`;
        } else if (rateEl) {
            rateEl.textContent = rate ? `Курс: 1 $ = ${rate.toFixed(1)} ₴` : '';
        }
    };
    document.getElementById('shippingPrice').oninput    = updateRate;
    document.getElementById('shippingDelivery').oninput = updateRate;
    // Явно знімаємо будь-який readonly і вмикаємо редагування
    ['shippingPrice','shippingDelivery'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.removeAttribute('readonly'); el.removeAttribute('disabled'); el.style.pointerEvents = 'auto'; }
    });
    // Показуємо поточний курс
    window.getUsdRate().then(rate => {
        const rateEl = document.getElementById('shippingRateInfo');
        if (rateEl) rateEl.textContent = `Курс: 1 $ = ${rate.toFixed(1)} ₴`;
        window._currentShippingRate = rate;
        updateRate();
    });
    document.getElementById('shippingModal').classList.add('active');
};
window.copyShipField = function(fieldId, btn) {
    const val = document.getElementById(fieldId)?.value?.trim();
    if (!val) return;
    navigator.clipboard.writeText(val).then(() => {
        btn.classList.add('copied');
        const orig = btn.innerHTML;
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = orig; }, 1500);
    });
};
window.closeShippingModal = function() {
    document.getElementById('shippingModal').classList.remove('active');
    _shippingRow = null;
};
window.saveShippingData = function() {
    if (!_shippingRow) return;
    const row = _shippingRow;
    const name     = document.getElementById('shipName').value.trim();
    const street   = document.getElementById('shipStreet').value.trim();
    const city     = document.getElementById('shipCity').value.trim();
    const country  = document.getElementById('shipCountry').value.trim();
    const email    = document.getElementById('shipEmail').value.trim();
    const phone    = document.getElementById('shipPhone').value.trim();
    const priceUsd    = parseFloat(document.getElementById('shippingPrice').value) || 0;
    const deliveryUsd = parseFloat(document.getElementById('shippingDelivery').value) || 0;
    const rate = window._currentShippingRate || window._usdRate || 41;
    // Зберігаємо в UAH
    const priceUah    = priceUsd    > 0 ? Math.round(priceUsd    * rate).toString() : '';
    const deliveryUah = deliveryUsd > 0 ? Math.round(deliveryUsd * rate).toString() : '';
    const fullAddress = [name, street, city, country, email, phone].filter(Boolean).join('\n');
    const get = (type) => (row.querySelector(`td[data-type="${type}"]`)?.dataset.val || '').trim();
    const prod   = get('product');
    const sizes  = get('size').split(/\n|,/).map(s=>s.trim()).filter(Boolean);
    const colors = get('color').split(/\n|,/).map(s=>s.trim()).filter(Boolean);
    if (fullAddress) {
        const recipientCell = row.querySelector('td[data-type="recipient"]');
        if (recipientCell) {
            recipientCell.dataset.val = fullAddress;
            window.renderRecipientCell(recipientCell, fullAddress);
        }
    }
    // Зберігаємо email і phone окремо в dataset рядка
    if (email) row.dataset.shipEmail = email;
    if (phone) row.dataset.shipPhone = phone;
    // Зберігаємо ціну/доставку конкретно цього рядка як атрибути на <tr>
    if (priceUsd > 0) row.dataset.priceUsd = priceUsd;
    if (deliveryUsd > 0) row.dataset.deliveryUsd = deliveryUsd;
    // Також зберігаємо в pricingData (для статистики і середніх у картках товарів)
    if ((priceUah || deliveryUah) && prod) {
        if (!window.pricingData[prod]) window.pricingData[prod] = {};
        const count = Math.max(sizes.length, colors.length, 1);
        for (let i = 0; i < count; i++) {
            const sz  = sizes[i]  || sizes[0]  || 'all';
            const col = colors[i] || colors[0] || 'all';
            const pKey = sz + '|' + col;
            if (!window.pricingData[prod][pKey]) window.pricingData[prod][pKey] = {};
            if (priceUah)    window.pricingData[prod][pKey].price    = priceUah;
            if (deliveryUah) window.pricingData[prod][pKey].delivery = deliveryUah;
        }
        db.collection("babak_crm").doc("pricing_state").set(window.pricingData)
            .catch(e => console.error('Помилка збереження ціни:', e));
    }
    saveData();
    if (typeof syncRowToDb === 'function') syncRowToDb(row);
    window.closeShippingModal();
    showToast('Відправку збережено!');
};
function formatTimeDiff(ms) {
    let mins = Math.floor(ms / 60000);
    if (mins === 0) return 'менше хвилини';
    let hours = Math.floor(mins / 60);
    let days = Math.floor(hours / 24);
    mins = mins % 60;
    hours = hours % 24;
    let res = [];
    if (days > 0) res.push(`${days} дн.`);
    if (hours > 0) res.push(`${hours} год.`);
    if (mins > 0 || res.length === 0) res.push(`${mins} хв.`);
    return res.join(' ');
}
// --- ФУНКЦИИ ДЛЯ ИКОНОК "РЕДАКТИРОВАТЬ" И "УДАЛИТЬ" ---
window.openEditDirectly = function(e, name, unit, id) {
    e.stopPropagation(); // Не дает клику провалиться на карточку
    openEditModal(name, unit, false, id);
};
window.deleteMaterialQuick = function(e, id) {
    e.stopPropagation(); // Блокируем клик на карточку
    if (userRole === 'limited') { alert('Тільки адміністратор може видаляти'); return; }
    
    if(confirm('Видалити цю позицію назавжди? Вона зникне зі складу.')) {
        const existingIndex = materialsData.findIndex(m => m.id === id);
        if (existingIndex >= 0) {
            materialsData[existingIndex].isHidden = true;
            materialsData[existingIndex].qty = 0;
            
            db.collection("babak_crm").doc("materials_state").set({ items: materialsData })
                .then(() => { 
                    showToast('Позицію видалено'); 
                    renderMaterialsTable(); 
                }); 
        }
    }
};
// --- ЛОГІКА ШВИДКОГО ДОДАВАННЯ (КНОПКА +) ---
// Автоматично створюємо HTML модалки, якщо його ще немає
if (!document.getElementById('quickAddModal')) {
    const qaModalHtml = `
    <div id="quickAddModal" class="modal-overlay no-print" onclick="closeQuickAdd()">
        <div class="mac-modal" style="width: 320px; padding: 24px; text-align: center; border-radius: 24px; background: #fff;" onclick="event.stopPropagation()">
            <h3 style="margin: 0 0 8px 0; font-size: 18px; color: #111827;">Поповнення запасів</h3>
            <p id="qaMatName" style="font-size: 13px; color: #6B7280; margin: 0 0 20px 0;">Матеріал</p>
            <input type="hidden" id="qaMatId">
            <input type="hidden" id="qaIsColor">
            
            <input type="number" id="qaAmount" class="mac-input" placeholder="+ Введіть кількість" style="text-align: center; font-size: 18px; font-weight: 600; padding: 16px; width: 100%; box-sizing: border-box; background: #f9f9fb; border: 1px solid #e5e7eb; border-radius: 12px; margin-bottom: 20px; outline: none;" onkeydown="if(event.key==='Enter') saveQuickAdd()">
            
            <div style="display: flex; gap: 10px; justify-content: center;">
                <button style="flex: 1; background: white; color: #111827; border: 1px solid #e5e7eb; padding: 12px; border-radius: 12px; font-weight: 600; cursor: pointer; transition: 0.2s;" onmouseover="this.style.background='#f9f9fb'" onmouseout="this.style.background='white'" onclick="closeQuickAdd()">Скасувати</button>
                <button style="flex: 1; background: #111827; color: white; border: none; padding: 12px; border-radius: 12px; font-weight: 600; cursor: pointer; transition: 0.2s;" onmouseover="this.style.background='#374151'" onmouseout="this.style.background='#111827'" onclick="saveQuickAdd()">Додати</button>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', qaModalHtml);
}
window.openQuickAdd = function(e, id, name, isColor) {
    e.stopPropagation(); // Блокуємо відкриття великого вікна редагування
    
    document.getElementById('qaMatId').value = id;
    document.getElementById('qaIsColor').value = isColor;
    
    // Якщо це фарба (в базі зберігається в мл), підказуємо це
    const unitText = isColor ? ' (вкажіть в мл)' : '';
    document.getElementById('qaMatName').innerText = name + unitText;
    document.getElementById('qaAmount').value = '';
    
    const modal = document.getElementById('quickAddModal');
    modal.classList.add('active');
    
    // Автоматично ставимо курсор в поле вводу
    setTimeout(() => document.getElementById('qaAmount').focus(), 100);
};
window.closeQuickAdd = function() {
    document.getElementById('quickAddModal').classList.remove('active');
};
window.saveQuickAdd = function() {
    if (userRole === 'limited') { alert('Тільки адміністратор може змінювати склад'); return; }
    
    const id = document.getElementById('qaMatId').value;
    const amountToAdd = parseFloat(document.getElementById('qaAmount').value);
    
    if (isNaN(amountToAdd) || amountToAdd <= 0) {
        alert('Введіть коректну кількість для додавання!');
        return;
    }
    const matIndex = materialsData.findIndex(m => m.id === id);
    if (matIndex >= 0) {
        // Додаємо введену кількість до поточного залишку
        materialsData[matIndex].qty += amountToAdd;
        
        // Зберігаємо в Firebase
        db.collection("babak_crm").doc("materials_state").set({ items: materialsData })
            .then(() => { 
                showToast(`Додано: +${amountToAdd}`); 
                closeQuickAdd();
                renderMaterialsTable(); // Оновлюємо таблицю
            });
    }
};
// --- ЛОГІКА ДЛЯ МАСОВОГО ДОДАВАННЯ ПРАВИЛ КОЛЬОРАМ ---
// --- РОЗУМНА АВТО-ГРУППИРОВКА ТА ІНДИВІДУАЛЬНІ КОЛЬОРИ ДЛЯ МАСОВОГО ВІКНА ---
// ==========================================
// --- НОВА СИСТЕМА: ІНДИВІДУАЛЬНІ РЕЦЕПТИ ТОВАРІВ ---
// ==========================================
window.currentRecipeProduct = '';
window.recipeRules = [];
// ==========================================
// --- НОВА СИСТЕМА: ІНДИВІДУАЛЬНІ РЕЦЕПТИ ТОВАРІВ (ЗІ ЗГОРТАННЯМ) ---
// ==========================================
window.currentRecipeProduct = '';
window.recipeRules = [];
// ==========================================
// --- НОВА СИСТЕМА: ІНДИВІДУАЛЬНІ РЕЦЕПТИ ТОВАРІВ (КВАДРАТНІ КАРТКИ + РОЗДІЛИ) ---
// ==========================================
window.currentRecipeProduct = '';
window.recipeRules = [];
// ==========================================
// --- НОВА СИСТЕМА: ІНДИВІДУАЛЬНІ РЕЦЕПТИ ТОВАРІВ (ФІНАЛЬНИЙ ДИЗАЙН) ---
// ==========================================
window.currentRecipeProduct = '';
window.recipeRules = [];
// ==========================================
// --- НОВА СИСТЕМА: ІНДИВІДУАЛЬНІ РЕЦЕПТИ ТОВАРІВ (ШИРОКІ КАРТКИ З ЛІВИМ ВИРІВНЮВАННЯМ) ---
// ==========================================
window.currentRecipeProduct = '';
window.recipeRules = [];
if (!document.getElementById('productRecipeModal')) {
    document.body.insertAdjacentHTML('beforeend', `
    <div id="productRecipeModal" class="modal-overlay no-print" onclick="closeProductRecipeModal()">
        <style>
            #productRecipeModal .mac-modal::-webkit-scrollbar { width: 5px; }
            #productRecipeModal .mac-modal::-webkit-scrollbar-thumb { background: #e5e7eb; border-radius: 10px; }
            .prod-card { background: white; border: 1.5px solid #f3f4f6; border-radius: 14px; padding: 16px 18px; cursor: pointer; transition: all 0.18s; }
            .prod-card:hover { border-color: #374151; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
            .detail-back { display:inline-flex; align-items:center; gap:6px; color:#9ca3af; font-size:13px; font-weight:600; cursor:pointer; background:none; border:none; padding:0; transition:0.15s; }
            .detail-back:hover { color:#111827; }
        </style>
        <div class="mac-modal" style="width:860px; max-width:95vw; padding:32px; max-height:90vh; overflow-y:auto;" onclick="event.stopPropagation()">
            <div id="recipeMainView">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
                    <div>
                        <h3 id="recipeModalTitle" style="margin:0 0 3px 0; font-size:20px; color:#111827; font-weight:800;"></h3>
                        <p style="font-size:12px; color:#9ca3af; margin:0;">Натисни на картку щоб редагувати рецепт і ціну</p>
                    </div>
                    <button class="mac-btn-secondary" onclick="closeProductRecipeModal()">Закрити</button>
                </div>
                <div id="recipeCardsContainer"></div>
            </div>
            <div id="recipeDetailView" style="display:none;">
                <div style="height:1px; background:#f3f4f6; margin:28px 0 24px;"></div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px;">
                    <h3 id="detailTitle" style="margin:0; font-size:18px; font-weight:800; color:#111827; display:flex; align-items:center; gap:8px;"></h3>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div id="detailCostBadge" style="font-size:12px; color:#374151; font-weight:600; background:#f3f4f6; border:1px solid #e5e7eb; padding:3px 12px; border-radius:8px;"></div>
                        <button class="detail-back" onclick="window.showRecipeMainView()" style="color:#9ca3af; font-size:12px;">
                            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><path d="M18 6L6 18M6 6l12 12"/></svg>
                            Закрити
                        </button>
                    </div>
                </div>
                <div class="recipe-price-grid" style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:10px; margin-bottom:10px;">
                    <div style="background:#f9f9fb; border-radius:12px; padding:14px 16px; border:1px solid #e5e7eb;">
                        <div style="font-size:10px; color:#9ca3af; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Ціна продажу</div>
                        <input type="number" id="detailPriceInput" placeholder="—" readonly style="width:100%; padding:0; border:none; font-size:18px; font-weight:800; color:#111827; outline:none; background:transparent; box-sizing:border-box; cursor:default;">
                    </div>
                    <div style="background:#f9f9fb; border-radius:12px; padding:14px 16px; border:1px solid #e5e7eb;">
                        <div style="font-size:10px; color:#9ca3af; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Доставка</div>
                        <input type="number" id="detailDeliveryInput" placeholder="—" readonly style="width:100%; padding:0; border:none; font-size:18px; font-weight:800; color:#111827; outline:none; background:transparent; box-sizing:border-box; cursor:default;">
                    </div>
                    <div style="background:#f9f9fb; border-radius:12px; padding:14px 16px; border:1px solid #e5e7eb;">
                        <div style="font-size:10px; color:#9ca3af; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Прибуток</div>
                        <div id="detailProfitDisplay" style="font-size:18px; font-weight:800; color:#374151;">—</div>
                    </div>
                    <div style="background:#f9f9fb; border-radius:12px; padding:14px 16px; border:1px solid #e5e7eb;">
                        <div style="font-size:10px; color:#9ca3af; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">Маржа</div>
                        <div id="detailMarginDisplay" style="font-size:18px; font-weight:800; color:#374151;">—</div>
                    </div>
                </div>
                <div id="detailPriceCount" style="font-size:11px;color:#9ca3af;margin-bottom:18px;text-align:right;"></div>
                <div id="recipeRulesContainer" style="background:#f9f9fb; border:1px solid #e5e7eb; border-radius:14px; padding:20px; min-height:140px; margin-bottom:18px;"></div>
                <div style="display:flex; gap:10px; justify-content:flex-end;">
                    <button class="mac-btn-secondary" onclick="window.showRecipeMainView()">Скасувати</button>
                    <button class="mac-btn-primary" onclick="saveProductRecipe()">Зберегти</button>
                </div>
            </div>
        </div>
    </div>`);
}
window.currentRecipeProduct = '';
window.currentRecipeSize = 'all';
window.currentRecipeColor = 'all';
window.currentRecipeViewMode = 'recipe';
window.recipeMatrix = {};
if (!window.pricingData) window.pricingData = {};
// Курс USD/UAH — кешуємо на 1 годину
window._usdRate = null;
window._usdRateTime = 0;
window.getUsdRate = async function() {
    const now = Date.now();
    if (window._usdRate && (now - window._usdRateTime) < 3600000) return window._usdRate;
    try {
        const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const d = await r.json();
        window._usdRate = d.rates?.UAH || 41;
        window._usdRateTime = now;
        return window._usdRate;
    } catch(e) {
        return window._usdRate || 41; // fallback 41 грн
    }
};
// Преfetch при старті
window.getUsdRate();
db.collection("babak_crm").doc("pricing_state").get().then(doc => {
    if (doc.exists) window.pricingData = doc.data();
}).catch(e => {});
window.showRecipeMainView = function() {
    document.getElementById('recipeDetailView').style.display = 'none';
    window.activeRecipeColor = null;
    window.renderRecipeCards();
};
window.renderProductsDashboard = function() {
    const container = document.getElementById('productsDashboard');
    if (!container) return;
    let products = [];
    if (menuData['product']) {
        menuData['product'].forEach(p => { if (p.text !== 'Очистити') products.push(p.text); });
    }
    const hasHw = products.some(p => p.toLowerCase().includes('хот') || p.toLowerCase().includes('hot'));
    if (!hasHw) products.unshift('Хотвілс');
    // Збираємо реальні розміри і кольори з таблиці для кожного товару
    let ordersByProduct = {};
    let sizesByProduct = {};
    let colorsByProduct = {};
    document.querySelectorAll('#tableBody tr').forEach(row => {
        const prodCell = row.querySelector('td[data-type="product"]');
        if (!prodCell) return;
        const name = (prodCell.dataset.val || prodCell.innerText || '').trim();
        if (!name) return;
        ordersByProduct[name] = (ordersByProduct[name] || 0) + 1;
        const sizeCell = row.querySelector('td[data-type="size"]');
        const colorCell = row.querySelector('td[data-type="color"]');
        if (!sizesByProduct[name]) sizesByProduct[name] = new Set();
        if (!colorsByProduct[name]) colorsByProduct[name] = new Set();
        (sizeCell?.dataset.val || '').split(/\n|,/).map(s=>s.trim()).filter(Boolean).forEach(s => sizesByProduct[name].add(s));
        (colorCell?.dataset.val || '').split(/\n|,/).map(s=>s.trim()).filter(Boolean).forEach(c => colorsByProduct[name].add(c));
    });
    if (!products.length) {
        container.innerHTML = `<div style="text-align:center;padding:60px 20px;color:#9ca3af;">
            <div style="font-size:40px;margin-bottom:12px;">📦</div>
            <div style="font-size:14px;font-weight:600;">Товарів ще немає</div>
            <div style="font-size:12px;margin-top:6px;">Додай товари в замовлення щоб вони з'явились тут</div>
        </div>`;
        return;
    }
    let html = `<div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:14px;">`;
    products.forEach(prod => {
        const isHw = prod.toLowerCase().includes('хот') || prod.toLowerCase().includes('hot');
        const orders = ordersByProduct[prod] || 0;
        // Кольори та розміри: спочатку з productConfigs, потім з таблиці, потім глобальні
        const allColors = isHw ? (window.hwColors || []) : (window.kopilkaColors || []);
        const usedColorNames = colorsByProduct[prod] || new Set();
        const usedSizes = sizesByProduct[prod] ? Array.from(sizesByProduct[prod]) : [];
        const configSizes = isHw ? (window.hwSizes || []) : (menuData['size'] ? menuData['size'].filter(s=>s.text!=='Очистити').map(s=>s.text) : []);
        const cfg = window.productConfigs && window.productConfigs[prod];
        const sizes  = cfg && cfg.sizes  && cfg.sizes.length  ? cfg.sizes  : (usedSizes.length > 0 ? usedSizes : configSizes);
        const colors = cfg && cfg.colors && cfg.colors.length ? cfg.colors : (usedColorNames.size > 0 ? allColors.filter(c => usedColorNames.has(c.name)) : allColors);
        const dots = colors.slice(0, 7).map(c =>
            `<span style="width:11px;height:11px;border-radius:50%;background:${c.hex};border:1px solid rgba(0,0,0,0.08);display:inline-block;flex-shrink:0;" title="${c.name}"></span>`
        ).join('');
        const moreDots = colors.length > 7
            ? `<span style="font-size:10px;color:#9ca3af;font-weight:600;margin-left:2px;">+${colors.length - 7}</span>` : '';
        const sizesHtml = sizes.map(s =>
            `<span style="font-size:10px;font-weight:700;color:#6B7280;background:#f3f4f6;padding:2px 8px;border-radius:6px;">${s}</span>`
        ).join('');
        html += `<div style="position:relative;background:white;border:1.5px solid #f3f4f6;border-radius:16px;padding:20px;cursor:pointer;transition:all 0.18s;display:flex;flex-direction:column;gap:12px;"
            onmouseover="this.style.borderColor='#374151';this.style.boxShadow='0 4px 16px rgba(0,0,0,0.07)';this.querySelector('.prod-settings-btn').style.opacity='1'"
            onmouseout="this.style.borderColor='#f3f4f6';this.style.boxShadow='none';this.querySelector('.prod-settings-btn').style.opacity='0'"
            onclick="window.openProductRecipeModal('${prod.replace(/'/g,"\\'")}')">
            <button class="prod-settings-btn" onclick="event.stopPropagation();window.openAddProductModal('${prod.replace(/'/g,"\\'")}');"
                style="position:absolute;top:12px;right:12px;width:28px;height:28px;border-radius:8px;border:1.5px solid #e5e7eb;background:white;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;transition:0.15s;padding:0;" title="Налаштування товару">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="#6B7280" stroke-width="2" fill="none"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding-right:24px;">
                <div style="font-size:14px;font-weight:800;color:#111827;line-height:1.3;">${prod}</div>
                ${orders > 0 ? `<span style="flex-shrink:0;font-size:11px;font-weight:700;color:#6B7280;background:#f3f4f6;padding:2px 8px;border-radius:20px;">${orders} зам.</span>` : ''}
            </div>
            ${sizesHtml ? `<div style="display:flex;gap:4px;flex-wrap:wrap;">${sizesHtml}</div>` : ''}
            <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">${dots}${moreDots}</div>
        </div>`;
    });
    html += `
        <div onclick="window.openAddProductModal()" style="background:transparent;border:1.5px dashed #e5e7eb;border-radius:16px;padding:20px;cursor:pointer;transition:all 0.18s;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:100px;color:#9ca3af;"
            onmouseover="this.style.borderColor='#111827';this.style.color='#111827';this.style.background='rgba(17,24,39,0.02)'"
            onmouseout="this.style.borderColor='#e5e7eb';this.style.color='#9ca3af';this.style.background='transparent'">
            <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <span style="font-size:12px;font-weight:600;">Новий товар</span>
        </div>
    </div>`;
    container.innerHTML = html;
};
// ==========================================
// КОНФІГУРАЦІЯ ТОВАРІВ (розміри, кольори)
// ==========================================
window.productConfigs = {}; // { "Копілка": { sizes: ["S","M"], colors: [{name,hex}] } }
db.collection("babak_crm").doc("product_configs").onSnapshot(doc => {
    if (doc.exists) window.productConfigs = doc.data();
});
window._saveProductConfigs = function() {
    db.collection("babak_crm").doc("product_configs").set(window.productConfigs).catch(e => {});
};
// Повертає кольори для конкретного товару (з конфігу або глобальні)
window.getProductColors = function(prodName) {
    if (!prodName) return window.kopilkaColors || [];
    const cfg = window.productConfigs[prodName];
    if (cfg && cfg.colors && cfg.colors.length > 0) return cfg.colors;
    const isHw = prodName.toLowerCase().includes('хот') || prodName.toLowerCase().includes('hot');
    return isHw ? (window.hwColors || []) : (window.kopilkaColors || []);
};
// Повертає розміри для конкретного товару (з конфігу або глобальні)
window.getProductSizes = function(prodName) {
    if (!prodName) return [];
    const cfg = window.productConfigs[prodName];
    if (cfg && cfg.sizes && cfg.sizes.length > 0) return cfg.sizes;
    const isHw = prodName.toLowerCase().includes('хот') || prodName.toLowerCase().includes('hot');
    if (isHw) return window.hwSizes || ['XS','S','M','L'];
    return menuData['size'] ? menuData['size'].filter(s=>s.text!=='Очистити').map(s=>s.text) : ['S','M'];
};
window.openAddProductModal = function(editProdName) {
    const existing = document.getElementById('_addProductModal');
    if (existing) existing.remove();
    const isEdit = !!editProdName;
    const cfg = isEdit ? (window.productConfigs && window.productConfigs[editProdName] || {}) : {};
    window._newProdSizes  = isEdit ? [...(cfg.sizes  || [])] : [];
    window._newProdColors = isEdit ? (cfg.colors || []).map(c => c.name) : [];
    const allAvailColors = [...(window.kopilkaColors||[]), ...(window.hwColors||[])].filter((c,i,a) => a.findIndex(x=>x.name===c.name)===i);
    const allSizes = ['XS','S','M','L','XL','XXL'];
    // Overlay
    const overlay = document.createElement('div');
    overlay.id = '_addProductModal';
    Object.assign(overlay.style, { position:'fixed', inset:'0', background:'rgba(0,0,0,0.4)', zIndex:'9999', display:'flex', alignItems:'center', justifyContent:'center' });
    // Card
    const card = document.createElement('div');
    Object.assign(card.style, { background:'white', borderRadius:'20px', padding:'28px', width:'460px', maxWidth:'96vw', boxShadow:'0 20px 60px rgba(0,0,0,0.15)' });
    card.addEventListener('click', e => e.stopPropagation());
    // Title
    const title = document.createElement('div');
    title.style.cssText = 'font-size:16px;font-weight:800;color:#111827;margin-bottom:20px;';
    title.textContent = isEdit ? 'Налаштування товару' : 'Новий товар';
    card.appendChild(title);
    // Name input
    const nameLabel = document.createElement('label');
    nameLabel.style.cssText = 'font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:8px;';
    nameLabel.textContent = 'Назва товару';
    card.appendChild(nameLabel);
    const nameInput = document.createElement('input');
    nameInput.id = '_newProdName';
    nameInput.type = 'text';
    nameInput.value = isEdit ? editProdName : '';
    nameInput.placeholder = 'Наприклад: Копілка тройна';
    nameInput.style.cssText = 'width:100%;box-sizing:border-box;padding:11px 14px;border:1.5px solid #e5e7eb;border-radius:12px;font-size:14px;font-weight:600;outline:none;font-family:inherit;margin-bottom:18px;' + (isEdit ? 'background:#f9f9fb;' : '');
    if (isEdit) nameInput.readOnly = true;
    nameInput.onfocus = () => nameInput.style.borderColor = '#111827';
    nameInput.onblur  = () => nameInput.style.borderColor = '#e5e7eb';
    card.appendChild(nameInput);
    // Sizes
    const sizesLabel = document.createElement('label');
    sizesLabel.style.cssText = 'font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:8px;';
    sizesLabel.textContent = 'Розміри';
    card.appendChild(sizesLabel);
    const sizesRow = document.createElement('div');
    sizesRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px;';
    allSizes.forEach(s => {
        const btn = document.createElement('button');
        btn.textContent = s;
        btn.style.cssText = `padding:5px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1.5px solid ${window._newProdSizes.includes(s)?'#111827':'#e5e7eb'};background:${window._newProdSizes.includes(s)?'#111827':'white'};color:${window._newProdSizes.includes(s)?'white':'#6B7280'};transition:0.12s;font-family:inherit;`;
        btn.onclick = () => {
            const idx = window._newProdSizes.indexOf(s);
            if (idx === -1) window._newProdSizes.push(s); else window._newProdSizes.splice(idx, 1);
            const active = window._newProdSizes.includes(s);
            btn.style.background = active ? '#111827' : 'white';
            btn.style.color = active ? 'white' : '#6B7280';
            btn.style.borderColor = active ? '#111827' : '#e5e7eb';
        };
        sizesRow.appendChild(btn);
    });
    card.appendChild(sizesRow);
    // Colors
    const colorsLabel = document.createElement('label');
    colorsLabel.style.cssText = 'font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.4px;display:block;margin-bottom:8px;';
    colorsLabel.textContent = 'Кольори';
    card.appendChild(colorsLabel);
    const colorsRow = document.createElement('div');
    colorsRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px;';
    allAvailColors.forEach(c => {
        const dot = document.createElement('div');
        dot.title = c.name;
        const isActive = window._newProdColors.includes(c.name);
        dot.style.cssText = `width:28px;height:28px;border-radius:50%;background:${c.hex};border:3px solid ${isActive?'#111827':'rgba(0,0,0,0.1)'};cursor:pointer;transition:0.12s;flex-shrink:0;`;
        dot.onmouseover = () => dot.style.transform = 'scale(1.15)';
        dot.onmouseout  = () => dot.style.transform = 'scale(1)';
        dot.onclick = () => {
            const idx = window._newProdColors.indexOf(c.name);
            if (idx === -1) window._newProdColors.push(c.name); else window._newProdColors.splice(idx, 1);
            dot.style.borderColor = window._newProdColors.includes(c.name) ? '#111827' : 'rgba(0,0,0,0.1)';
        };
        colorsRow.appendChild(dot);
    });
    card.appendChild(colorsRow);
    // Buttons row
    const btnsRow = document.createElement('div');
    btnsRow.style.cssText = 'display:flex;gap:10px;justify-content:space-between;align-items:center;';
    const leftSide = document.createElement('div');
    if (isEdit) {
        const delBtn = document.createElement('button');
        delBtn.textContent = '🗑 Видалити';
        delBtn.style.cssText = 'padding:10px 16px;border-radius:10px;border:1.5px solid #fee2e2;background:#fff5f5;color:#dc2626;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;';
        delBtn.onclick = () => window._deleteProduct(editProdName);
        leftSide.appendChild(delBtn);
    }
    btnsRow.appendChild(leftSide);
    const rightSide = document.createElement('div');
    rightSide.style.cssText = 'display:flex;gap:8px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Скасувати';
    cancelBtn.style.cssText = 'padding:10px 18px;border-radius:10px;border:1.5px solid #e5e7eb;background:white;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;';
    cancelBtn.onclick = () => overlay.remove();
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Зберегти';
    saveBtn.style.cssText = 'padding:10px 20px;border-radius:10px;border:none;background:#111827;color:white;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;';
    saveBtn.onclick = () => window._saveNewProduct(isEdit ? editProdName : '');
    rightSide.appendChild(cancelBtn);
    rightSide.appendChild(saveBtn);
    btnsRow.appendChild(rightSide);
    card.appendChild(btnsRow);
    overlay.appendChild(card);
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
    setTimeout(() => nameInput.focus(), 50);
};
window._saveNewProduct = function(editName) {
    const name = document.getElementById('_newProdName')?.value?.trim() || editName;
    if (!name) return;
    document.getElementById('_addProductModal')?.remove();
    // Зберігаємо в menuData якщо новий
    if (!editName) {
        if (!menuData['product']) menuData['product'] = [];
        if (!menuData['product'].some(p => p.text === name)) {
            menuData['product'].push({ text: name, class: 'badge-status', customStyle: 'background-color: #f3f4f6; color: #374151;' });
        }
    }
    // Зберігаємо конфіг (розміри + кольори)
    const allAvailColors = [...(window.kopilkaColors||[]), ...(window.hwColors||[])].filter((c,i,a)=>a.findIndex(x=>x.name===c.name)===i);
    const selectedColors = allAvailColors.filter(c => window._newProdColors.includes(c.name));
    window.productConfigs[name] = {
        sizes:  window._newProdSizes,
        colors: selectedColors
    };
    window._saveProductConfigs();
    saveData();
    window.renderProductsDashboard();
    showToast(`"${name}" ${editName ? 'оновлено' : 'додано'} ✓`);
};
window._deleteProduct = function(name) {
    if (!confirm(`Видалити товар "${name}"? Він залишиться в існуючих замовленнях, але пропаде з вибору.`)) return;
    document.getElementById('_addProductModal')?.remove();
    if (menuData['product']) {
        menuData['product'] = menuData['product'].filter(p => p.text !== name);
    }
    delete window.productConfigs[name];
    window._saveProductConfigs();
    saveData();
    window.renderProductsDashboard();
    showToast(`"${name}" видалено`);
};
window.openAddColorModal = function() {
    const existing = document.getElementById('_addColorModal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = '_addColorModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
        <div style="background:white;border-radius:20px;padding:28px;width:380px;max-width:95vw;box-shadow:0 20px 60px rgba(0,0,0,0.15);" onclick="event.stopPropagation()">
            <div style="font-size:16px;font-weight:800;color:#111827;margin-bottom:18px;">Новий колір фарби</div>
            <div style="display:flex;gap:10px;margin-bottom:12px;">
                <input id="_newColorName" type="text" placeholder="Назва кольору" style="flex:1;padding:12px 14px;border:1.5px solid #e5e7eb;border-radius:12px;font-size:14px;font-weight:600;outline:none;font-family:inherit;" onfocus="this.style.borderColor='#111827'" onblur="this.style.borderColor='#e5e7eb'">
                <div style="position:relative;">
                    <input id="_newColorHex" type="color" value="#aaaaaa" style="width:50px;height:48px;border-radius:12px;border:1.5px solid #e5e7eb;cursor:pointer;padding:4px;" title="Колір">
                </div>
            </div>
            <div style="font-size:11px;color:#9ca3af;margin-bottom:18px;">Колір з'явиться в розділі Матеріали та в рецептах товарів</div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button onclick="document.getElementById('_addColorModal').remove()" style="padding:10px 18px;border-radius:10px;border:1.5px solid #e5e7eb;background:white;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Скасувати</button>
                <button onclick="window._saveNewColor()" style="padding:10px 20px;border-radius:10px;border:none;background:#111827;color:white;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">Додати</button>
            </div>
        </div>`;
    modal.addEventListener('click', () => modal.remove());
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('_newColorName')?.focus(), 50);
};
window._saveNewColor = function() {
    const name = document.getElementById('_newColorName')?.value?.trim();
    const hex  = document.getElementById('_newColorHex')?.value || '#aaaaaa';
    if (!name) return;
    document.getElementById('_addColorModal')?.remove();
    if (window.kopilkaColors.some(c => c.name === name)) { showToast('Такий колір вже є'); return; }
    window.kopilkaColors.push({ name, hex });
    renderMaterialsTable();
    showToast(`"${name}" додано ✓`);
};
window.resetFinancesView = function() {
    window._finPeriod      = 'month';
    window._finFrom        = '';
    window._finTo          = '';
    window._finFilterProd  = '';
    window._finFilterSize  = '';
    window._finFilterColor = '';
    window._finExpanded    = {};
    window.renderFinancesDashboard();
    showToast('Вигляд скинуто');
};
window.resetAllPriceData = function() {
    if (!confirm('Скинути всі збережені ціни і доставку? Це видалить дані з усіх замовлень і карток товарів.')) return;
    // Очищаємо pricingData в Firebase
    window.pricingData = {};
    db.collection("babak_crm").doc("pricing_state").set({}).catch(e => {});
    // Очищаємо data-price-usd і data-delivery-usd з усіх рядків таблиці
    document.querySelectorAll('#tableBody tr').forEach(row => {
        delete row.dataset.priceUsd;
        delete row.dataset.deliveryUsd;
    });
    saveData();
    window.renderFinancesDashboard();
    showToast('Розрахунки скинуто');
};
window.renderFinancesDashboard = function() {
    const container = document.getElementById('financesDashboard');
    if (!container) return;
    // Зчитуємо рядки таблиці — тільки зі статусом "Відправлено"
    const rows = [];
    document.querySelectorAll('#tableBody tr').forEach(row => {
        // Ігноруємо display:none від пагінації, але не від фільтра статусу —
        // фінанси читають всі рядки зі статусом "Відправлено" незалежно від фільтра таблиці
        const get = (type) => (row.querySelector(`td[data-type="${type}"]`)?.dataset.val || row.querySelector(`td[data-type="${type}"]`)?.innerText || '').trim();
        const dateRaw = get('date');
        const prod = get('product');
        if (!prod || prod === '—') return;
        // Тільки "Відправлено" і не приховані з фінансів
        const statusText = (row.querySelector('td[data-type="status"] .badge')?.innerText || get('status')).trim();
        if (!statusText.includes('Відправлено') && !statusText.includes('Відправл')) return;
        if (row.dataset.hiddenFromFinances === 'true') return;
        const dateMatch = dateRaw.match(/(\d{2}\/\d{2})/);
        const dateStr = dateMatch ? dateMatch[1] : '';
        // Парсимо дату (формат MM/DD або DD/MM — беремо першу)
        let dateObj = null;
        if (dateStr) {
            const parts = dateStr.split('/');
            const now = new Date();
            dateObj = new Date(now.getFullYear(), parseInt(parts[0])-1, parseInt(parts[1]));
        }
        const sizesRaw = get('size').split(/\n|,/).map(s=>s.trim()).filter(Boolean);
        const colorsRaw = get('color').split(/\n|,/).map(s=>s.trim()).filter(Boolean);
        const count = Math.max(sizesRaw.length, colorsRaw.length, 1);
        // Ціна і доставка — з атрибутів конкретного рядка (в USD, конвертуємо в UAH)
        const rowPriceUsd    = parseFloat(row.dataset.priceUsd)    || 0;
        const rowDeliveryUsd = parseFloat(row.dataset.deliveryUsd) || 0;
        const rate = window._usdRate || 41;
        const rowPrice    = rowPriceUsd    > 0 ? Math.round(rowPriceUsd    * rate) : 0;
        const rowDelivery = rowDeliveryUsd > 0 ? Math.round(rowDeliveryUsd * rate) : 0;
        for (let i = 0; i < count; i++) {
            const size = sizesRaw[i] || sizesRaw[0] || 'all';
            const color = colorsRaw[i] || colorsRaw[0] || 'all';
            // Собівартість — фарба рахується тільки якщо її назва = замовлений колір
            const _allColorNms = new Set([...(window.kopilkaColors||[]), ...(window.hwColors||[])].map(c => c.name));
            let cost = 0;
            materialsData.forEach(mat => {
                if (!mat.rules || mat.isHidden) return;
                if (_allColorNms.has(mat.name) && mat.name !== color) return;
                mat.rules.forEach(r => {
                    if ((r.product||'all') !== prod && (r.product||'all') !== 'all') return;
                    if ((r.size||'all') !== size && (r.size||'all') !== 'all') return;
                    if ((r.productColor||'all') !== color && (r.productColor||'all') !== 'all') return;
                    cost += (parseFloat(r.amount)||0) * (parseFloat(mat.price)||0);
                });
            });
            const price    = count > 1 ? Math.round(rowPrice / count)    : rowPrice;
            const delivery = count > 1 ? Math.round(rowDelivery / count) : rowDelivery;
            const profit = price > 0 ? price - cost - delivery : 0;
            const orderId = row.dataset.orderId || '';
            rows.push({ prod, size, color, price, cost, delivery, profit, dateObj, dateStr, orderId });
        }
    });
    // Поточний фільтр
    if (!window._finPeriod) window._finPeriod = 'month';
    if (!window._finFrom) window._finFrom = '';
    if (!window._finTo) window._finTo = '';
    if (!window._finFilterProd)  window._finFilterProd  = '';
    if (!window._finFilterSize)  window._finFilterSize  = '';
    if (!window._finFilterColor) window._finFilterColor = '';
    const now = new Date();
    let filtered = rows.filter(r => {
        if (!r.dateObj) return true;
        if (window._finPeriod === 'week') {
            const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
            return r.dateObj >= weekAgo;
        }
        if (window._finPeriod === 'month') {
            const monthAgo = new Date(now); monthAgo.setMonth(now.getMonth() - 1);
            return r.dateObj >= monthAgo;
        }
        if (window._finPeriod === 'custom' && window._finFrom) {
            const from = new Date(window._finFrom);
            const to = window._finTo ? new Date(window._finTo) : now;
            return r.dateObj >= from && r.dateObj <= to;
        }
        return true;
    });
    // Збираємо унікальні значення для чіпсів (з усіх рядків до додаткових фільтрів)
    const allProds   = [...new Set(filtered.map(r => r.prod))].filter(Boolean).sort();
    const allSizes   = [...new Set(filtered.map(r => r.size).filter(s => s && s !== 'all'))].sort();
    const allColors  = [...new Set(filtered.map(r => r.color).filter(c => c && c !== 'all'))].sort();
    // Застосовуємо додаткові фільтри
    if (window._finFilterProd)  filtered = filtered.filter(r => r.prod  === window._finFilterProd);
    if (window._finFilterSize)  filtered = filtered.filter(r => r.size  === window._finFilterSize);
    if (window._finFilterColor) filtered = filtered.filter(r => r.color === window._finFilterColor);
    const totalRevenue  = filtered.reduce((s,r) => s + r.price, 0);
    const totalMatCost  = filtered.reduce((s,r) => s + r.cost, 0);
    const totalDelivery = filtered.reduce((s,r) => s + r.delivery, 0);
    const totalCost     = totalMatCost + totalDelivery;  // собівартість = матеріали + доставка
    const totalProfit   = filtered.reduce((s,r) => s + r.profit, 0);
    const margin = totalRevenue > 0 ? ((totalProfit/totalRevenue)*100).toFixed(1) : '0';
    const periodBtns = ['week','month','all','custom'].map(p => {
        const labels = {week:'Тиждень', month:'Місяць', all:'Весь час', custom:'Дата'};
        const isActive = window._finPeriod === p;
        return `<button onclick="window._finPeriod='${p}'; window.renderFinancesDashboard();" style="
            padding:6px 14px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer;
            border:1.5px solid ${isActive ? '#111827' : '#e5e7eb'};
            background:${isActive ? '#111827' : 'white'};
            color:${isActive ? 'white' : '#6B7280'};
            transition:0.15s; font-family:inherit;
        ">${labels[p]}</button>`;
    }).join('');
    const customDateHtml = window._finPeriod === 'custom' ? `
        <div style="display:flex;align-items:center;gap:8px;margin-top:12px;">
            <input type="date" value="${window._finFrom}" onchange="window._finFrom=this.value; window.renderFinancesDashboard();"
                style="padding:6px 10px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:13px;font-family:inherit;outline:none;color:#111827;">
            <span style="color:#9ca3af;font-size:13px;">—</span>
            <input type="date" value="${window._finTo}" onchange="window._finTo=this.value; window.renderFinancesDashboard();"
                style="padding:6px 10px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:13px;font-family:inherit;outline:none;color:#111827;">
        </div>` : '';
    const summaryCards = [
        { label: 'Дохід',        value: totalRevenue.toFixed(0)  + ' ₴', color: '#111827', bg: '#f9f9fb' },
        { label: 'Матеріали',    value: totalMatCost.toFixed(0)  + ' ₴', color: '#374151', bg: '#f9f9fb' },
        { label: 'Доставка',     value: totalDelivery.toFixed(0) + ' ₴', color: '#374151', bg: '#f9f9fb' },
        { label: 'Собівартість', value: totalCost.toFixed(0)     + ' ₴', color: '#374151', bg: '#f9f9fb' },
        { label: 'Прибуток',     value: totalProfit.toFixed(0)   + ' ₴', color: totalProfit >= 0 ? '#15803d' : '#dc2626', bg: totalProfit >= 0 ? '#f0fdf4' : '#fef2f2' },
        { label: 'Маржа',        value: margin + ' %',                    color: totalProfit >= 0 ? '#15803d' : '#dc2626', bg: totalProfit >= 0 ? '#f0fdf4' : '#fef2f2' },
    ].map(c => `
        <div style="background:${c.bg};border:1.5px solid #f3f4f6;border-radius:14px;padding:16px 20px;">
            <div style="font-size:11px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">${c.label}</div>
            <div style="font-size:22px;font-weight:800;color:${c.color};">${c.value}</div>
        </div>`).join('');
    // Список рядків з розкладкою матеріалів
    if (!window._finExpanded) window._finExpanded = {};
    const getCostBreakdown = (prod, size, color) => {
        const items = [];
        const allColorNamesSet = new Set([...(window.kopilkaColors||[]), ...(window.hwColors||[])].map(c => c.name));
        materialsData.forEach(mat => {
            if (!mat.rules || mat.isHidden) return;
            // Фарба рахується тільки якщо її назва = замовлений колір
            if (allColorNamesSet.has(mat.name) && mat.name !== color) return;
            let totalAmt = 0;
            mat.rules.forEach(r => {
                if ((r.product||'all') !== prod && (r.product||'all') !== 'all') return;
                if ((r.size||'all') !== size && (r.size||'all') !== 'all') return;
                if ((r.productColor||'all') !== color && (r.productColor||'all') !== 'all') return;
                totalAmt += parseFloat(r.amount) || 0;
            });
            if (totalAmt > 0) {
                const price = parseFloat(mat.price) || 0;
                const subtotal = totalAmt * price;
                const allCols = [...(window.hwColors||[]), ...(window.kopilkaColors||[])];
                const colorObj = allCols.find(c => c.name === mat.name);
                items.push({ name: mat.name, unit: mat.unit || '', amount: totalAmt, price, subtotal, isColor: !!colorObj, hex: colorObj?.hex });
            }
        });
        return items.sort((a,b) => b.subtotal - a.subtotal);
    };
    const listHtml = filtered.length === 0
        ? `<div style="text-align:center;padding:40px;color:#9ca3af;font-size:14px;">Немає даних за цей період</div>`
        : filtered.map((r, idx) => {
            const allColorsArr = [...(window.hwColors||[]), ...(window.kopilkaColors||[])];
            const colorObj = allColorsArr.find(c => c.name === r.color);
            const dot = colorObj ? `<span style="width:9px;height:9px;border-radius:50%;background:${colorObj.hex};border:1px solid rgba(0,0,0,0.1);display:inline-block;flex-shrink:0;"></span>` : '';
            const profitColor = r.profit > 0 ? '#15803d' : r.profit < 0 ? '#dc2626' : '#9ca3af';
            const expKey = `${idx}_${r.prod}_${r.size}_${r.color}`;
            const isExpanded = !!window._finExpanded[expKey];
            const breakdown = isExpanded ? getCostBreakdown(r.prod, r.size, r.color) : [];
            const breakdownHtml = isExpanded ? `
                <div style="background:#f9f9fb;border-top:1px solid #f3f4f6;padding:10px 16px 10px 64px;">
                    ${breakdown.length === 0 && r.delivery === 0
                        ? `<div style="font-size:11px;color:#9ca3af;font-style:italic;">Рецепт не налаштовано</div>`
                        : [
                            ...breakdown.map(item => {
                                const circleDot = item.isColor
                                    ? `<span style="width:8px;height:8px;border-radius:50%;background:${item.hex};border:1px solid rgba(0,0,0,0.12);display:inline-block;flex-shrink:0;margin-right:4px;"></span>`
                                    : '';
                                return `<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;border-bottom:1px solid #f3f4f6;">
                                    <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:#6B7280;">${circleDot}${item.name}</div>
                                    <div style="display:flex;align-items:center;gap:16px;">
                                        <span style="font-size:11px;color:#9ca3af;">${item.amount % 1 === 0 ? item.amount : item.amount.toFixed(2)} ${item.unit} × ${item.price} ₴</span>
                                        <span style="font-size:11px;font-weight:700;color:#374151;min-width:50px;text-align:right;">${item.subtotal.toFixed(2)} ₴</span>
                                    </div>
                                </div>`;
                            }),
                            r.delivery > 0 ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;border-bottom:1px solid #f3f4f6;">
                                <div style="font-size:11px;color:#6B7280;">🚚 Доставка</div>
                                <span style="font-size:11px;font-weight:700;color:#374151;min-width:50px;text-align:right;">${r.delivery.toFixed(0)} ₴</span>
                            </div>` : ''
                          ].join('')
                    }
                    ${(breakdown.length > 0 || r.delivery > 0) ? `<div style="display:flex;justify-content:flex-end;padding-top:6px;font-size:12px;font-weight:800;color:#111827;">Разом: ${(r.cost + r.delivery).toFixed(0)} ₴</div>` : ''}
                </div>` : '';
            return `<div style="border-bottom:1px solid #f9f9fb;">
                <div style="display:flex;align-items:center;padding:12px 16px;gap:12px;cursor:pointer;transition:background 0.1s;"
                    onclick="window._finExpanded['${expKey}']=!window._finExpanded['${expKey}'];window.renderFinancesDashboard();"
                    onmouseover="this.style.background='#f9f9fb'" onmouseout="this.style.background='${isExpanded ? '#fafafa' : 'transparent'}'">
                    <div style="font-size:11px;color:#9ca3af;font-weight:500;min-width:36px;">${r.dateStr || '—'}</div>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;font-weight:700;color:#111827;">${r.prod}</div>
                        <div style="display:flex;align-items:center;gap:5px;margin-top:3px;">
                            ${r.size !== 'all' ? `<span style="font-size:11px;font-weight:700;color:#6B7280;background:#f3f4f6;padding:1px 6px;border-radius:4px;">${r.size}</span>` : ''}
                            ${dot}<span style="font-size:11px;color:#9ca3af;">${r.color !== 'all' ? r.color : ''}</span>
                        </div>
                    </div>
                    <div style="text-align:right;min-width:70px;">
                        <div style="font-size:11px;color:#9ca3af;">Собів.</div>
                        <div style="font-size:12px;font-weight:600;color:#374151;">${(r.cost + r.delivery) > 0 ? (r.cost + r.delivery).toFixed(0)+' ₴' : '—'}</div>
                    </div>
                    <div style="text-align:right;min-width:70px;">
                        <div style="font-size:11px;color:#9ca3af;">Ціна</div>
                        <div style="font-size:12px;font-weight:600;color:#111827;">${r.price > 0 ? r.price.toFixed(0)+' ₴' : '—'}</div>
                    </div>
                    <div style="text-align:right;min-width:80px;">
                        <div style="font-size:11px;color:#9ca3af;">Прибуток</div>
                        <div style="font-size:14px;font-weight:800;color:${profitColor};">${r.price > 0 ? (r.profit >= 0 ? '+' : '') + r.profit.toFixed(0)+' ₴' : '—'}</div>
                    </div>
                    <div style="margin-left:4px;color:#9ca3af;transition:transform 0.2s;transform:rotate(${isExpanded ? '180' : '0'}deg);">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </div>
                    ${r.orderId ? `<div onclick="event.stopPropagation();if(confirm('Прибрати цей запис з фінансів?')){const domRow=document.querySelector('tr[data-order-id=\\'${r.orderId}\\']');if(domRow)domRow.dataset.hiddenFromFinances='true';window.renderFinancesDashboard();db.collection('orders').doc('${r.orderId}').update({hiddenFromFinances:true})}" style="margin-left:4px;color:#d1d5db;cursor:pointer;padding:4px;border-radius:4px;transition:0.15s;" onmouseover="this.style.color='#ef4444'" onmouseout="this.style.color='#d1d5db'" title="Прибрати з фінансів">
                        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3.2 4.8h9.6l-.8 8.8c-.1.8-.8 1.6-1.6 1.6H5.6c-.8 0-1.5-.8-1.6-1.6l-.8-8.8zm2.4 8h1.6V6.4H5.6V12.8zm3.2 0h1.6V6.4H8.8V12.8zM4.8 3.2V1.6C4.8.7 5.5 0 6.4 0h3.2c.9 0 1.6.7 1.6 1.6v1.6h3.2v1.6H1.6V3.2h3.2zM6.4 1.6v1.6h3.2V1.6H6.4z"/></svg>
                    </div>` : ''}
                </div>
                ${breakdownHtml}
            </div>`;
        }).join('');
    // Селекти фільтрів
    const selectStyle = `padding:6px 28px 6px 10px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #e5e7eb;background:white url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E") no-repeat right 8px center;-webkit-appearance:none;appearance:none;color:#111827;outline:none;font-family:inherit;transition:0.15s;`;
    const activeSelectStyle = selectStyle.replace('border:1.5px solid #e5e7eb', 'border:1.5px solid #111827');
    const makeSelect = (vals, stateKey, placeholder) => {
        const cur = window[stateKey] || '';
        const isActive = !!cur;
        const opts = vals.map(v => `<option value="${v.replace(/"/g,'&quot;')}" ${cur===v?'selected':''}>${v}</option>`).join('');
        return `<select style="${isActive ? activeSelectStyle : selectStyle}" onchange="window['${stateKey}']=this.value;window.renderFinancesDashboard();">
            <option value="">${placeholder}</option>
            ${opts}
        </select>`;
    };
    const hasFilters = window._finFilterProd || window._finFilterSize || window._finFilterColor;
    const filtersHtml = (allProds.length > 1 || allSizes.length > 1 || allColors.length > 1) ? `
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            ${allProds.length  > 1 ? makeSelect(allProds,  '_finFilterProd',  'Товар')  : ''}
            ${allSizes.length  > 1 ? makeSelect(allSizes,  '_finFilterSize',  'Розмір') : ''}
            ${allColors.length > 1 ? makeSelect(allColors, '_finFilterColor', 'Колір')  : ''}
            ${hasFilters ? `<button onclick="window._finFilterProd='';window._finFilterSize='';window._finFilterColor='';window.renderFinancesDashboard();" style="padding:6px 10px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #e5e7eb;background:transparent;color:#9ca3af;transition:0.15s;font-family:inherit;" onmouseover="this.style.color='#111827'" onmouseout="this.style.color='#9ca3af'">✕ Скинути</button>` : ''}
        </div>` : '';
    container.innerHTML = `
        <div style="padding:0 0 20px 0;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px;">
                <h2 style="margin:0;font-size:18px;font-weight:800;color:#111827;">Фінансова аналітика</h2>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">${periodBtns}</div>
                    <button onclick="window.resetFinancesView()" style="padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #e5e7eb;background:#f9f9fb;color:#6B7280;transition:0.15s;font-family:inherit;" onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='#f9f9fb'" title="Скинути фільтри та вигляд">↺ Скинути</button>
                    <button onclick="window.resetAllPriceData()" style="padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #fee2e2;background:#fff5f5;color:#dc2626;transition:0.15s;font-family:inherit;" onmouseover="this.style.background='#fee2e2'" onmouseout="this.style.background='#fff5f5'" title="Очистити всі збережені ціни і доставку з замовлень">🗑 Очистити ціни</button>
                </div>
            </div>
            ${customDateHtml}
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:24px;${customDateHtml ? 'margin-top:14px;' : ''}">
                ${summaryCards}
            </div>
            <div style="background:white;border:1.5px solid #f3f4f6;border-radius:16px;overflow:hidden;">
                <div style="padding:14px 16px;border-bottom:1px solid #f3f4f6;">
                    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
                        <span style="font-size:13px;font-weight:700;color:#111827;">Деталізація (${filtered.length} позицій)</span>
                        ${filtersHtml}
                    </div>
                </div>
                ${listHtml}
            </div>
        </div>`;
};
window.openProductRecipeModal = function(prodName) {
    window.currentRecipeProduct = prodName;
    document.getElementById('recipeModalTitle').innerText = prodName === 'Будь-який товар' ? 'Загальний рецепт' : prodName;
    document.getElementById('recipeMainView').style.display = '';
    document.getElementById('recipeDetailView').style.display = 'none';
    window.activeRecipeSize = null;
    window.activeRecipeColor = null;
    window.renderRecipeCards();
    document.getElementById('productRecipeModal').classList.add('active');
};
window.activeRecipeSize = null;
window.renderRecipeCards = function() {
    const container = document.getElementById('recipeCardsContainer');
    if (!container) return;
    const prod = window.currentRecipeProduct;
    const isHw = prod.toLowerCase().includes('хот') || prod.toLowerCase().includes('hot');
    // Збираємо реальні розміри/кольори з замовлень для цього товару
    let orderSizesSet = new Set();
    let orderColorsSet = new Set();
    let orderCounts = {};
    document.querySelectorAll('#tableBody tr').forEach(row => {
        const productCell = row.querySelector('td[data-type="product"]');
        if (!productCell) return;
        const rowProd = (productCell.dataset.val || productCell.innerText || '').trim();
        if (rowProd.toLowerCase() !== prod.toLowerCase()) return;
        const sizeCell = row.querySelector('td[data-type="size"]');
        const colorCell = row.querySelector('td[data-type="color"]');
        const rowSizes = (sizeCell?.dataset.val || '').split(/\n|,/).map(s=>s.trim()).filter(Boolean);
        const rowColors = (colorCell?.dataset.val || '').split(/\n|,/).map(s=>s.trim()).filter(Boolean);
        rowSizes.forEach(s => orderSizesSet.add(s));
        rowColors.forEach(c => orderColorsSet.add(c));
        const base = Math.max(rowSizes.length, rowColors.length, 1);
        for (let i = 0; i < base; i++) {
            let s = rowSizes[i] || rowSizes[0] || 'all';
            let c = rowColors[i] || rowColors[0] || 'all';
            orderCounts[s + '|' + c] = (orderCounts[s + '|' + c] || 0) + 1;
        }
    });
    // Використовуємо конфіг товару (якщо є) або глобальні значення
    let sizes, colors;
    if (isHw) {
        const cfgSizes  = window.getProductSizes(prod);
        const cfgColors = window.getProductColors(prod);
        sizes  = cfgSizes.length  ? cfgSizes  : (window.hwSizes || []);
        colors = cfgColors.length ? cfgColors.map(c => c.name) : (window.hwColors || []).map(c => c.name);
    } else {
        const cfgSizes  = window.getProductSizes(prod);
        const cfgColors = window.getProductColors(prod);
        // Розміри: з конфігу, або якщо немає — з замовлень, або всі з menu
        sizes = cfgSizes.length ? cfgSizes
              : orderSizesSet.size > 0
                ? (menuData['size']||[]).filter(s=>s.text!=='Очистити').map(s=>s.text).filter(s => orderSizesSet.has(s))
                : (menuData['size']||[]).filter(s=>s.text!=='Очистити').map(s=>s.text);
        colors = cfgColors.length ? cfgColors.map(c => c.name) : (window.kopilkaColors || []).map(c => c.name);
    }
    const allColorNames = new Set([...(window.kopilkaColors||[]), ...(window.hwColors||[])].map(c => c.name));
    function calcCost(size, color) {
        let total = 0;
        materialsData.forEach(mat => {
            if (!mat.rules || mat.isHidden) return;
            // Якщо матеріал — це фарба (колір), рахуємо тільки якщо її назва збігається з замовленим кольором
            const isPaint = allColorNames.has(mat.name);
            if (isPaint && mat.name !== color) return;
            mat.rules.forEach(r => {
                if ((r.product||'all') !== prod && (r.product||'all') !== 'all') return;
                if ((r.size||'all') !== size && (r.size||'all') !== 'all') return;
                if ((r.productColor||'all') !== color && (r.productColor||'all') !== 'all') return;
                total += (parseFloat(r.amount)||0) * (parseFloat(mat.price)||0);
            });
        });
        return total;
    }
    if (!window.activeRecipeSize && sizes.length > 0) window.activeRecipeSize = sizes[0];
    // Таби розмірів
    let sizesHtml = sizes.map(size => {
        let isActive = window.activeRecipeSize === size;
        let totalOrders = colors.reduce((sum, c) => sum + (orderCounts[size+'|'+c]||0), 0);
        return `<div onclick="window.activeRecipeSize='${size}'; window.renderRecipeCards();" style="
            display:inline-flex; align-items:center; gap:8px;
            padding: 10px 20px; border-radius: 12px; cursor: pointer;
            font-weight: 700; font-size: 15px; transition: all 0.2s;
            background: ${isActive ? '#111827' : '#f3f4f6'};
            color: ${isActive ? 'white' : '#6B7280'};
            border: 2px solid ${isActive ? '#111827' : 'transparent'};
        ">${size}${totalOrders > 0 ? `<span style="background:${isActive?'rgba(255,255,255,0.2)':'#e5e7eb'};color:${isActive?'white':'#374151'};font-size:11px;font-weight:700;padding:2px 7px;border-radius:20px;">${totalOrders}</span>` : ''}</div>`;
    }).join('');
    // Картки кольорів для активного розміру
    let cardsHtml = '';
    if (window.activeRecipeSize) {
        colors.forEach(color => {
            let size = window.activeRecipeSize;
            let cost = calcCost(size, color);
            let orders = orderCounts[size+'|'+color] || 0;
            // Середня ціна з таблиці
            let avg = window.calcAvgPriceDelivery ? window.calcAvgPriceDelivery(prod, size, color) : {price:0, delivery:0, count:0};
            let avgPrice = avg.price;
            let avgDelivery = avg.delivery;
            let profit = avgPrice > 0 ? (avgPrice - cost - avgDelivery) : null;
            let colorObj = (window.hwColors||[]).find(x=>x.name===color) || (window.kopilkaColors||[]).find(x=>x.name===color);
            let dot = colorObj ? `<span style="width:10px;height:10px;border-radius:50%;background:${colorObj.hex};border:1px solid rgba(0,0,0,0.1);display:inline-block;flex-shrink:0;"></span>` : '';
            let profitColor = profit !== null ? (profit >= 0 ? '#16a34a' : '#dc2626') : '#9ca3af';
            let hasRecipe = cost > 0;
            let isSelected = window.activeRecipeColor === color && window.activeRecipeSize === size;
            cardsHtml += `<div onclick="window.openRecipeDetail('${size}','${color.replace(/'/g,"\\'")}'); " style="
                background:${isSelected ? '#f8faff' : 'white'}; 
                border:2px solid ${isSelected ? '#6366f1' : (hasRecipe ? '#e5e7eb' : '#f3f4f6')};
                border-radius:14px; padding:16px 18px; cursor:pointer;
                transition:all 0.18s; display:flex; flex-direction:column; gap:10px;
                box-shadow:${isSelected ? '0 4px 16px rgba(99,102,241,0.12)' : 'none'};
            " onmouseover="if(!${isSelected}){this.style.borderColor='#6366f1';this.style.boxShadow='0 4px 16px rgba(99,102,241,0.1)';}"
               onmouseout="if(!${isSelected}){this.style.borderColor='${hasRecipe ? '#e5e7eb' : '#f3f4f6'}';this.style.boxShadow='none';}">
                <div style="display:flex;align-items:center;gap:8px;">
                    ${dot}
                    <span style="font-size:14px;font-weight:700;color:#111827;">${color}</span>
                    ${orders > 0 ? `<span style="margin-left:auto;font-size:11px;font-weight:700;color:#6B7280;background:#f3f4f6;padding:2px 8px;border-radius:20px;">${orders} зам.</span>` : ''}
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#9ca3af;">
                    <span>Собівартість</span>
                    <span style="font-weight:700;color:${hasRecipe?'#111827':'#d1d5db'};">${hasRecipe ? cost.toFixed(2)+' ₴' : '—'}</span>
                </div>
                ${avgPrice > 0 ? `<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#9ca3af;"><span>Ціна (сер.)</span><span style="font-weight:700;color:#111827;">${avgPrice} ₴</span></div>` : ''}
                <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid #f3f4f6;">
                    <span style="font-size:12px;color:#9ca3af;">Прибуток</span>
                    <span style="font-size:14px;font-weight:800;color:${profitColor};">${profit !== null ? profit.toFixed(0)+' ₴' : '—'}</span>
                </div>
            </div>`;
        });
    }
    container.innerHTML = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">${sizesHtml}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;">${cardsHtml}</div>
    `;
};
window._prodCardHtml = function(size, color, dot, cost, orders, profit, pricing) {
    let profitColor = profit !== null ? (profit >= 0 ? '#15803d' : '#dc2626') : '#9ca3af';
    let profitText = profit !== null ? profit.toFixed(0) + ' ₴' : '—';
    let marginText = (profit !== null && pricing.price && parseFloat(pricing.price) > 0) 
        ? ((profit / parseFloat(pricing.price)) * 100).toFixed(0) + '%' : '—';
    return `
    <div class="prod-card" onclick="window.openRecipeDetail('${size}', '${color.replace(/'/g,"\\'")}')">
        <div class="prod-card-size">${size !== 'all' ? size : ''}</div>
        <div class="prod-card-color">${dot} ${color}</div>
        <div class="prod-card-stat"><span>Собівартість</span><span>${cost.toFixed(2)} ₴</span></div>
        <div class="prod-card-stat"><span>Замовлень</span><span>${orders}</span></div>
        ${pricing.price ? `<div class="prod-card-stat"><span>Ціна</span><span>${pricing.price} ₴</span></div>` : ''}
        <div class="prod-card-profit">
            <span style="font-size:12px; color:#6B7280; font-weight:600;">Прибуток</span>
            <span style="font-size:15px; font-weight:800; color:${profitColor};">${profitText}</span>
        </div>
        ${profit !== null ? `<div style="text-align:right; font-size:11px; color:${profitColor}; font-weight:700; margin-top:4px;">Маржа: ${marginText}</div>` : ''}
    </div>`;
};
window.activeRecipeColor = null;
// Обраховуємо середню ціну і доставку з таблиці замовлень для конкретного товару+розмір+колір
window.calcAvgPriceDelivery = function(prod, size, color) {
    const rate = window._usdRate || 41;
    let priceSum = 0, deliverySum = 0, count = 0;
    // Збираємо реальні ціни з pricingData — ключі що містять size|color
    // Але тепер ціна зберігається з таблиці через модал відправки (вже в UAH)
    // Шукаємо точний ключ, потім суміжні (тільки size, тільки color, then all)
    const pricing = window.pricingData?.[prod];
    if (pricing) {
        const exactKey = size + '|' + color;
        // Збираємо всі записи де розмір або колір збігається
        Object.entries(pricing).forEach(([key, val]) => {
            const [kSize, kColor] = key.split('|');
            if (kSize === size || kColor === color || key === exactKey) {
                const p = parseFloat(val.price) || 0;
                const d = parseFloat(val.delivery) || 0;
                if (p > 0) { priceSum += p; deliverySum += d; count++; }
            }
        });
    }
    // Якщо даних немає — шукаємо середнє по ВСІХ варіантах товару
    if (count === 0 && pricing) {
        Object.values(pricing).forEach(val => {
            const p = parseFloat(val.price) || 0;
            const d = parseFloat(val.delivery) || 0;
            if (p > 0) { priceSum += p; deliverySum += d; count++; }
        });
    }
    if (count === 0) return { price: 0, delivery: 0, count: 0 };
    return {
        price: Math.round(priceSum / count),
        delivery: Math.round(deliverySum / count),
        count
    };
};
window.openRecipeDetail = function(size, color) {
    window.currentRecipeSize = size;
    window.currentRecipeColor = color;
    window.activeRecipeColor = color;
    const detailView = document.getElementById('recipeDetailView');
    detailView.style.display = '';
    const prod = window.currentRecipeProduct;
    let colorObj = (window.hwColors||[]).find(x=>x.name===color) || (window.kopilkaColors||[]).find(x=>x.name===color);
    let dot = colorObj ? `<span style="width:13px;height:13px;border-radius:50%;background:${colorObj.hex};border:1px solid rgba(0,0,0,0.1);display:inline-block;flex-shrink:0;"></span>` : '';
    document.getElementById('detailTitle').innerHTML = `${size !== 'all' ? `<span style="color:#9ca3af;font-weight:700;">${size}</span> ·` : ''} ${dot} ${color}`;
    // Заповнюємо середніми значеннями з таблиці
    window.updateDetailPriceFromAvg(prod, size, color);
    let tempGroup = {};
    materialsData.forEach(mat => {
        if (!mat.rules) return;
        mat.rules.forEach(r => {
            if ((r.product||'all') !== prod) return;
            let s = r.size || 'all';
            let c = r.productColor || 'all';
            let key = s + '|' + c;
            if (!tempGroup[key]) tempGroup[key] = { size: s, productColor: c, matAmounts: {} };
            tempGroup[key].matAmounts[mat.name] = r.amount;
        });
    });
    window.recipeRules = Object.values(tempGroup);
    if (window.recipeRules.length === 0) {
        window.recipeRules.push({ size: size, productColor: color, matAmounts: {} });
    }
    window.renderRecipeContent();
    window.calcDetailProfit();
    setTimeout(() => detailView.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    window.renderRecipeCards();
};
window.updateDetailPriceFromAvg = function(prod, size, color) {
    const avg = window.calcAvgPriceDelivery(prod, size, color);
    const priceEl = document.getElementById('detailPriceInput');
    const deliveryEl = document.getElementById('detailDeliveryInput');
    const countEl = document.getElementById('detailPriceCount');
    if (priceEl) priceEl.value = avg.price > 0 ? avg.price : '';
    if (deliveryEl) deliveryEl.value = avg.delivery > 0 ? avg.delivery : '';
    if (countEl) countEl.textContent = avg.count > 0 ? `≈ середнє з ${avg.count} зам.` : 'немає даних';
};
window.syncDetailPriceFields = function() {
    window.updateDetailPriceFromAvg(
        window.currentRecipeProduct,
        window.currentRecipeSize,
        window.currentRecipeColor
    );
    window.calcDetailProfit();
};
window.calcDetailProfit = function() {
    let p = parseFloat(document.getElementById('detailPriceInput')?.value) || 0;
    let d = parseFloat(document.getElementById('detailDeliveryInput')?.value) || 0;
    let costText = document.getElementById('detailCostBadge')?.innerText || '0';
    let cost = parseFloat(costText.replace(/[^0-9.]/g,'')) || 0;
    let pr = p - cost - d;
    let margin = p > 0 ? ((pr/p)*100).toFixed(1) : '0';
    let profitEl = document.getElementById('detailProfitDisplay');
    let marginEl = document.getElementById('detailMarginDisplay');
    if (profitEl) { profitEl.innerText = p > 0 ? pr.toFixed(2) + ' ₴' : '—'; profitEl.style.color = pr >= 0 ? '#15803d' : '#dc2626'; }
    if (marginEl) { marginEl.innerText = p > 0 ? margin + ' %' : '—'; }
};
window.saveDetailPrice = function() {
    let prod = window.currentRecipeProduct;
    let pKey = window.currentRecipeSize + '|' + window.currentRecipeColor;
    let price = document.getElementById('detailPriceInput')?.value || '';
    let delivery = document.getElementById('detailDeliveryInput')?.value || '';
    if (!window.pricingData[prod]) window.pricingData[prod] = {};
    window.pricingData[prod][pKey] = { price, delivery };
    db.collection("babak_crm").doc("pricing_state").set(window.pricingData)
        .then(() => showToast('Ціну збережено ✓'))
        .catch(e => console.error(e));
};
window.closeProductRecipeModal = function() {
    document.getElementById('productRecipeModal').classList.remove('active');
};
window.renderRecipeRulesList = function() {
    const sizeTabs = document.getElementById('recipeSizeTabs');
    const colorTabs = document.getElementById('recipeColorTabs');
    const container = document.getElementById('recipeRulesContainer');
    if (!sizeTabs || !colorTabs || !container) return;
    let prod = window.currentRecipeProduct;
    let isHw = prod.toLowerCase().includes('хот') || prod.toLowerCase().includes('hot');
    let sizes = ['all'];
    if (isHw && window.hwSizes) sizes.push(...window.hwSizes);
    else if (menuData['size']) { let s = new Set(); menuData['size'].forEach(x => { if(x.text !== 'Очистити') s.add(x.text); }); sizes.push(...s); }
    let colors = ['all'];
    if (isHw && window.hwColors) colors.push(...window.hwColors.map(c => c.name));
    else { let u = new Set(); if(window.kopilkaColors) window.kopilkaColors.forEach(c => u.add(c.name)); if(window.hwColors) window.hwColors.forEach(c => u.add(c.name)); colors.push(...u); }
    let allAvailableMats = [];
    if (window.kopilkaColors) window.kopilkaColors.forEach(c => allAvailableMats.push({ name: c.name, type: 'color', hex: c.hex }));
    if (window.hwColors) window.hwColors.forEach(c => { if(!allAvailableMats.find(m => m.name === c.name)) allAvailableMats.push({ name: c.name, type: 'color', hex: c.hex }); });
    const existingColNames = new Set(allAvailableMats.map(m => m.name));
    materialsData.forEach(m => { if (!existingColNames.has(m.name) && !m.isHidden) { if (!allAvailableMats.find(x => x.name === m.name)) allAvailableMats.push({ name: m.name, type: 'basic', unit: m.unit }); } });
    if (!sizes.includes(window.currentRecipeSize)) window.currentRecipeSize = 'all';
    if (!colors.includes(window.currentRecipeColor)) window.currentRecipeColor = 'all';
    sizeTabs.innerHTML = sizes.map(s => {
        let text = s === 'all' ? 'Всі розміри' : s;
        return `<button class="r-tab ${window.currentRecipeSize === s ? 'active' : ''}" onclick="window.currentRecipeSize='${s}'; window.currentRecipeColor='all'; window.renderRecipeRulesList(); window.syncDetailPriceFields();">${text}</button>`;
    }).join('');
    colorTabs.innerHTML = colors.map(c => {
        let text = c === 'all' ? 'Всі кольори' : c;
        let colObj = (window.hwColors||[]).find(x=>x.name===c) || (window.kopilkaColors||[]).find(x=>x.name===c);
        let dot = colObj ? `<span style="display:inline-block;min-width:12px;width:12px;height:12px;border-radius:50%;background:${colObj.hex};border:1px solid rgba(0,0,0,0.1);"></span>` : '';
        return `<button class="r-subtab ${window.currentRecipeColor === c ? 'active' : ''}" onclick="window.currentRecipeColor='${c.replace(/'/g,"\\'")}'; window.renderRecipeRulesList(); window.syncDetailPriceFields();">${dot}${text}</button>`;
    }).join('');
    let ruleIndex = window.recipeRules.findIndex(r => (r.size||'all') === window.currentRecipeSize && (r.productColor||'all') === window.currentRecipeColor);
    let currentRule = window.recipeRules[ruleIndex];
    if (!currentRule) {
        container.innerHTML = `<div style="text-align:center; padding:40px 20px;">
            <div style="font-size:40px; margin-bottom:12px;">🗂️</div>
            <h4 style="margin:0 0 8px 0; color:#111827;">Рецепт не створено</h4>
            <p style="color:#6B7280; font-size:13px; margin:0 auto 20px; max-width:300px;">Для <b>${window.currentRecipeSize === 'all' ? 'Всі розміри' : window.currentRecipeSize}</b> + <b>${window.currentRecipeColor === 'all' ? 'Всі кольори' : window.currentRecipeColor}</b></p>
            <button class="mac-btn-primary" onclick="window.createSpecificRecipe('${window.currentRecipeSize}', '${window.currentRecipeColor.replace(/'/g,"\\'")}')">+ Створити рецепт</button>
        </div>`;
        // Оновлюємо собівартість у деталях
        if (document.getElementById('detailCostBadge')) document.getElementById('detailCostBadge').innerText = 'Собівартість: 0.00 ₴';
        return;
    }
    let activeColorsHtml = ''; let inactiveColorsHtml = '';
    let activeBasicsHtml = ''; let inactiveBasicsHtml = '';
    let ruleTotalCost = 0;
    let costBreakdownHtml = '';
    allAvailableMats.forEach(mat => {
        const amt = (currentRule.matAmounts && currentRule.matAmounts[mat.name] !== undefined) ? currentRule.matAmounts[mat.name] : undefined;
        const isActive = amt !== undefined;
        const unitText = mat.type === 'color' ? 'мл' : mat.unit;
        let iconHtml = '';
        if (mat.type === 'color') {
            iconHtml = `<span style="display:inline-block;min-width:16px;width:16px;height:16px;background-color:${mat.hex};border:1px solid rgba(0,0,0,0.15);border-radius:50%;flex-shrink:0;margin:0;"></span>`;
        } else {
            let iconStyle = getIconStyleForMaterial(mat.name);
            iconHtml = `<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;background:${iconStyle.bg};color:${iconStyle.color};margin:0;flex-shrink:0;">${iconStyle.svg.replace('width:24px; height:24px;','width:14px; height:14px;')}</span>`;
        }
        if (isActive) {
            let realMat = materialsData.find(m => m.name === mat.name);
            let matPrice = (realMat && realMat.price) ? parseFloat(realMat.price) : 0;
            let itemCost = (parseFloat(amt) || 0) * matPrice;
            ruleTotalCost += itemCost;
            let tagHtml = `
            <div style="background:white;border:1px solid #e5e7eb;border-radius:16px;padding:12px;width:140px;display:flex;flex-direction:column;position:relative;">
                <svg viewBox="0 0 16 16" style="position:absolute;top:12px;right:12px;width:14px;height:14px;fill:#9ca3af;cursor:pointer;transition:0.2s;" onmouseover="this.style.fill='#ef4444'" onmouseout="this.style.fill='#9ca3af'" onclick="event.stopPropagation();removeRecipeMat(${ruleIndex},'${mat.name.replace(/'/g,"\\'")}')"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding-right:16px;">${iconHtml}<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;font-weight:600;">${mat.name}</span></div>
                <div style="display:flex;align-items:baseline;gap:6px;">
                    <input type="number" value="${amt}" placeholder="0" style="width:60px;padding:2px 0;border:none;border-bottom:2px solid #e5e7eb;font-size:16px;font-weight:700;outline:none;text-align:center;background:transparent;" onchange="updateRecipeMatAmount(${ruleIndex},'${mat.name.replace(/'/g,"\\'")}',this.value);window.renderRecipeRulesList();">
                    <span style="font-size:12px;color:#6B7280;">${unitText}</span>
                </div>
            </div>`;
            if (mat.type === 'color') activeColorsHtml += tagHtml;
            else activeBasicsHtml += tagHtml;
        } else {
            let optHtml = `<div class="dropdown-option" style="display:flex;align-items:center;" onclick="addRecipeMat(${ruleIndex},'${mat.name.replace(/'/g,"\\'")}',event)">${iconHtml.replace('margin:0','margin-right:8px')} ${mat.name}</div>`;
            if (mat.type === 'color') inactiveColorsHtml += optHtml;
            else inactiveBasicsHtml += optHtml;
        }
    });
    // Оновлюємо собівартість у шапці деталі
    if (document.getElementById('detailCostBadge')) {
        document.getElementById('detailCostBadge').innerText = `Собівартість: ${ruleTotalCost.toFixed(2)} ₴`;
        window.calcDetailProfit();
    }
    container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
            <span style="font-size:14px;font-weight:600;color:#111827;">Матеріали рецепту</span>
            <button style="color:#ef4444;background:#fee2e2;border:none;padding:6px 12px;border-radius:8px;font-weight:600;font-size:12px;cursor:pointer;" onclick="window.deleteSpecificRecipe(${ruleIndex})">Видалити рецепт</button>
        </div>
        <div style="margin-bottom:24px;">
            <div style="font-size:11px;color:#9ca3af;font-weight:700;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px;">Фарба</div>
            <div style="display:flex;flex-wrap:wrap;gap:12px;">
                ${activeColorsHtml}
                ${inactiveColorsHtml ? `<div class="custom-dropdown" tabindex="0" onblur="this.classList.remove('open')" onclick="this.classList.toggle('open')" style="border:none!important;background:transparent!important;box-shadow:none!important;padding:0;min-width:auto;"><div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:140px;min-height:100px;border:2px dashed #e5e7eb;border-radius:16px;color:#9ca3af;cursor:pointer;" onmouseover="this.style.borderColor='#111827';this.style.color='#111827'" onmouseout="this.style.borderColor='#e5e7eb';this.style.color='#9ca3af'"><svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" style="margin-bottom:8px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span style="font-size:12px;font-weight:600;">Додати колір</span></div><div class="dropdown-list" style="min-width:200px;left:0;top:100%;max-height:250px;z-index:100;">${inactiveColorsHtml}</div></div>` : ''}
            </div>
        </div>
        <div style="height:1px;background:#e5e7eb;margin:0 -24px 24px -24px;"></div>
        <div>
            <div style="font-size:11px;color:#9ca3af;font-weight:700;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px;">Основні матеріали</div>
            <div style="display:flex;flex-wrap:wrap;gap:12px;">
                ${activeBasicsHtml}
                ${inactiveBasicsHtml ? `<div class="custom-dropdown" tabindex="0" onblur="this.classList.remove('open')" onclick="this.classList.toggle('open')" style="border:none!important;background:transparent!important;box-shadow:none!important;padding:0;min-width:auto;"><div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:140px;min-height:100px;border:2px dashed #e5e7eb;border-radius:16px;color:#9ca3af;cursor:pointer;" onmouseover="this.style.borderColor='#111827';this.style.color='#111827'" onmouseout="this.style.borderColor='#e5e7eb';this.style.color='#9ca3af'"><svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" style="margin-bottom:8px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span style="font-size:12px;font-weight:600;">Додати матеріал</span></div><div class="dropdown-list" style="min-width:200px;left:0;top:100%;max-height:250px;z-index:100;">${inactiveBasicsHtml}</div></div>` : ''}
            </div>
        </div>
    `;
};
window.renderRecipeContent = function() {
    const container = document.getElementById('recipeRulesContainer');
    if (!container) return;
    let prod = window.currentRecipeProduct;
    let size = window.currentRecipeSize;
    let color = window.currentRecipeColor;
    let allAvailableMats = [];
    if (window.kopilkaColors) window.kopilkaColors.forEach(c => allAvailableMats.push({ name: c.name, type: 'color', hex: c.hex }));
    if (window.hwColors) window.hwColors.forEach(c => { if(!allAvailableMats.find(m=>m.name===c.name)) allAvailableMats.push({ name: c.name, type: 'color', hex: c.hex }); });
    materialsData.forEach(m => { if (!m.isHidden && !allAvailableMats.find(x=>x.name===m.name)) allAvailableMats.push({ name: m.name, type: 'basic', unit: m.unit }); });
    let ruleIndex = window.recipeRules.findIndex(r => (r.size||'all') === size && (r.productColor||'all') === color);
    let currentRule = window.recipeRules[ruleIndex];
    if (!currentRule) {
        container.innerHTML = `<div style="text-align:center;padding:40px 20px;">
            <div style="font-size:36px;margin-bottom:12px;">🗂️</div>
            <div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:6px;">Рецепт не створено</div>
            <div style="font-size:12px;color:#9ca3af;margin-bottom:20px;">Для ${size} · ${color}</div>
            <button class="mac-btn-primary" onclick="window.createSpecificRecipe('${size}','${color.replace(/'/g,"\\'")}')">+ Створити рецепт</button>
        </div>`;
        if (document.getElementById('detailCostBadge')) document.getElementById('detailCostBadge').innerText = 'Собівартість: 0.00 ₴';
        return;
    }
    let activeColorsHtml = ''; let inactiveColorsHtml = '';
    let activeBasicsHtml = ''; let inactiveBasicsHtml = '';
    let ruleTotalCost = 0;
    allAvailableMats.forEach(mat => {
        const amt = (currentRule.matAmounts && currentRule.matAmounts[mat.name] !== undefined) ? currentRule.matAmounts[mat.name] : undefined;
        const isActive = amt !== undefined;
        const unitText = mat.type === 'color' ? 'мл' : mat.unit;
        let iconHtml = mat.type === 'color'
            ? `<span style="display:inline-block;min-width:14px;width:14px;height:14px;background:${mat.hex};border:1px solid rgba(0,0,0,0.12);border-radius:50%;flex-shrink:0;"></span>`
            : `<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:${getIconStyleForMaterial(mat.name).bg};color:${getIconStyleForMaterial(mat.name).color};flex-shrink:0;">${getIconStyleForMaterial(mat.name).svg.replace('width:24px; height:24px;','width:13px; height:13px;')}</span>`;
        if (isActive) {
            let matPrice = parseFloat(materialsData.find(m=>m.name===mat.name)?.price)||0;
            ruleTotalCost += (parseFloat(amt)||0) * matPrice;
            let card = `<div style="background:white;border:1px solid #e5e7eb;border-radius:14px;padding:12px;width:130px;display:flex;flex-direction:column;position:relative;">
                <svg viewBox="0 0 16 16" style="position:absolute;top:10px;right:10px;width:13px;height:13px;fill:#d1d5db;cursor:pointer;" onmouseover="this.style.fill='#ef4444'" onmouseout="this.style.fill='#d1d5db'" onclick="event.stopPropagation();removeRecipeMat(${ruleIndex},'${mat.name.replace(/'/g,"\\'")}')"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
                <div style="display:flex;align-items:center;gap:7px;margin-bottom:10px;padding-right:14px;">${iconHtml}<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:600;color:#374151;">${mat.name}</span></div>
                <div style="display:flex;align-items:baseline;gap:5px;">
                    <input type="number" value="${amt}" placeholder="0" style="width:55px;padding:2px 0;border:none;border-bottom:1.5px solid #e5e7eb;font-size:15px;font-weight:700;outline:none;text-align:center;background:transparent;color:#111827;" onchange="updateRecipeMatAmount(${ruleIndex},'${mat.name.replace(/'/g,"\\'")}',this.value);window.renderRecipeContent();window.calcDetailProfit();">
                    <span style="font-size:11px;color:#9ca3af;">${unitText}</span>
                </div>
            </div>`;
            if (mat.type==='color') activeColorsHtml += card; else activeBasicsHtml += card;
        } else {
            let opt = `<div class="dropdown-option" style="display:flex;align-items:center;gap:8px;" onclick="addRecipeMat(${ruleIndex},'${mat.name.replace(/'/g,"\\'")}',event)">${iconHtml} ${mat.name}</div>`;
            if (mat.type==='color') inactiveColorsHtml += opt; else inactiveBasicsHtml += opt;
        }
    });
    if (document.getElementById('detailCostBadge')) {
        document.getElementById('detailCostBadge').innerText = `Собівартість: ${ruleTotalCost.toFixed(2)} ₴`;
        window.calcDetailProfit();
    }
    const addBtn = (label, inactive) => inactive ? `<div class="custom-dropdown" tabindex="0" onblur="this.classList.remove('open')" onclick="this.classList.toggle('open')" style="border:none!important;background:transparent!important;box-shadow:none!important;padding:0;"><div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:130px;min-height:90px;border:1.5px dashed #e5e7eb;border-radius:14px;color:#d1d5db;cursor:pointer;transition:0.15s;" onmouseover="this.style.borderColor='#374151';this.style.color='#374151'" onmouseout="this.style.borderColor='#e5e7eb';this.style.color='#d1d5db'"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" style="margin-bottom:6px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span style="font-size:11px;font-weight:600;">${label}</span></div><div class="dropdown-list" style="min-width:190px;left:0;top:100%;max-height:220px;z-index:100;">${inactive}</div></div>` : '';
    container.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:13px;font-weight:700;color:#374151;">Матеріали</span>
                <button onclick="window.openCopyRecipePopover(this)" style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;border:1.5px solid #e5e7eb;background:white;color:#6b7280;transition:0.15s;font-family:inherit;" onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='white'">
                    <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    Скопіювати рецепт
                </button>
            </div>
            <button style="color:#ef4444;background:transparent;border:none;font-size:12px;font-weight:600;cursor:pointer;padding:4px 8px;border-radius:6px;" onmouseover="this.style.background='#fee2e2'" onmouseout="this.style.background='transparent'" onclick="window.deleteSpecificRecipe(${ruleIndex})">Видалити рецепт</button>
        </div>
        <div id="copyRecipePopover" style="display:none;position:relative;z-index:50;margin-bottom:14px;"></div>
        <div style="margin-bottom:20px;">
            <div style="font-size:10px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Фарба</div>
            <div style="display:flex;flex-wrap:wrap;gap:10px;">${activeColorsHtml}${addBtn('Додати колір', inactiveColorsHtml)}</div>
        </div>
        <div style="height:1px;background:#f3f4f6;margin:0 -20px 20px;"></div>
        <div>
            <div style="font-size:10px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Основні матеріали</div>
            <div style="display:flex;flex-wrap:wrap;gap:10px;">${activeBasicsHtml}${addBtn('Додати матеріал', inactiveBasicsHtml)}</div>
        </div>
    `;
};
// Збираємо всі існуючі рецепти з materialsData для попапу копіювання
window.openCopyRecipePopover = function(btn) {
    const popover = document.getElementById('copyRecipePopover');
    if (!popover) return;
    if (popover.style.display !== 'none') { popover.style.display = 'none'; return; }
    const options = [];
    const seen = new Set();
    materialsData.forEach(mat => {
        if (!mat.rules || mat.isHidden) return;
        mat.rules.forEach(r => {
            const prod = r.product || 'all';
            const size = r.size || 'all';
            const color = r.productColor || 'all';
            const key = prod + '|' + size + '|' + color;
            if (!seen.has(key)) {
                seen.add(key);
                options.push({ prod, size, color, label: `${prod} · ${size !== 'all' ? size : 'всі розміри'} · ${color !== 'all' ? color : 'всі кольори'}` });
            }
        });
    });
    const currProd  = window.currentRecipeProduct;
    const currSize  = window.currentRecipeSize;
    const currColor = window.currentRecipeColor;
    const filtered = options.filter(o => !(o.prod === currProd && o.size === currSize && o.color === currColor));
    if (filtered.length === 0) {
        popover.style.display = 'block';
        popover.innerHTML = '<div style="background:white;border:1.5px solid #e5e7eb;border-radius:12px;padding:14px 16px;font-size:12px;color:#9ca3af;">Немає інших рецептів для копіювання</div>';
        return;
    }
    const itemsHtml = filtered.map(o => {
        const ps = o.prod.replace(/'/g, "\\'");
        const cs = o.color.replace(/'/g, "\\'");
        return `<div onclick="window.copyRecipeFrom('${ps}','${o.size}','${cs}');document.getElementById('copyRecipePopover').style.display='none';"
            style="padding:9px 14px;font-size:12px;font-weight:500;color:#111827;cursor:pointer;border-radius:8px;transition:0.12s;"
            onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='transparent'">
            ${o.label}
        </div>`;
    }).join('');
    popover.style.display = 'block';
    popover.innerHTML = `<div style="background:white;border:1.5px solid #e5e7eb;border-radius:12px;padding:6px;box-shadow:0 4px 16px rgba(0,0,0,0.08);max-height:220px;overflow-y:auto;">
        <div style="padding:8px 14px 6px;font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;">Скопіювати з:</div>
        ${itemsHtml}
    </div>`;
};
window.copyRecipeFrom = function(srcProd, srcSize, srcColor) {
    const copiedAmounts = {};
    materialsData.forEach(mat => {
        if (!mat.rules) return;
        mat.rules.forEach(r => {
            if ((r.product||'all') === srcProd && (r.size||'all') === srcSize && (r.productColor||'all') === srcColor) {
                copiedAmounts[mat.name] = r.amount;
            }
        });
    });
    if (Object.keys(copiedAmounts).length === 0) { showToast('Рецепт порожній'); return; }
    let idx = window.recipeRules.findIndex(r => (r.size||'all') === window.currentRecipeSize && (r.productColor||'all') === window.currentRecipeColor);
    if (idx === -1) {
        window.recipeRules.push({ size: window.currentRecipeSize, productColor: window.currentRecipeColor, matAmounts: {} });
        idx = window.recipeRules.length - 1;
    }
    window.recipeRules[idx].matAmounts = Object.assign({}, copiedAmounts, window.recipeRules[idx].matAmounts);
    window.renderRecipeContent();
    showToast('Рецепт скопійовано \u2713');
};
window.createSpecificRecipe = function(s, c) {
    window.currentRecipeSize = s;
    window.currentRecipeColor = c;
    window.recipeRules.push({ size: s, productColor: c, matAmounts: {} });
    window.renderRecipeContent();
};
window.deleteSpecificRecipe = function(idx) {
    if (confirm("Видалити цей рецепт?")) { window.recipeRules.splice(idx, 1); window.renderRecipeContent(); }
};
window.addRecipeMat = function(idx, matName, e) {
    if (e) e.stopPropagation();
    if (!window.recipeRules[idx]) return;
    if (!window.recipeRules[idx].matAmounts) window.recipeRules[idx].matAmounts = {};
    window.recipeRules[idx].matAmounts[matName] = 0;
    window.renderRecipeContent();
};
window.removeRecipeMat = function(idx, matName) {
    if (!window.recipeRules[idx]) return;
    delete window.recipeRules[idx].matAmounts[matName];
    window.renderRecipeContent();
};
window.updateRecipeMatAmount = function(idx, matName, value) {
    window.recipeRules[idx].matAmounts[matName] = value;
};
window.saveProductRecipe = function() {
    if (userRole === 'limited') { alert('Тільки адміністратор може змінювати склад'); return; }
    materialsData.forEach(mat => {
        if (mat.rules) { mat.rules = mat.rules.filter(rule => (rule.product || 'all') !== window.currentRecipeProduct); }
    });
    window.recipeRules.forEach(r => {
        let s = r.size || 'all';
        let c = r.productColor || 'all';
        if (!r.matAmounts) return;
        Object.entries(r.matAmounts).forEach(([matName, amtStr]) => {
            let amount = amtStr === '' ? 0 : parseFloat(amtStr);
            if (isNaN(amount) || amount < 0) return;
            let matIndex = materialsData.findIndex(m => m.name === matName);
            if (matIndex === -1) {
                let isColor = window.kopilkaColors.some(co => co.name === matName) || window.hwColors.some(co => co.name === matName);
                let mId = (isColor ? 'color_' : 'mat_') + Date.now() + Math.floor(Math.random()*1000);
                materialsData.push({ id: mId, name: matName, unit: isColor ? 'мл' : 'шт', qty: 0, rules: [], isHidden: false });
                matIndex = materialsData.length - 1;
            }
            if (!materialsData[matIndex].rules) materialsData[matIndex].rules = [];
            materialsData[matIndex].rules.push({ product: window.currentRecipeProduct, size: s, productColor: c, amount: amount });
            materialsData[matIndex].isHidden = false;
        });
    });
    db.collection("babak_crm").doc("materials_state").set({ items: materialsData })
        .then(() => { showToast('Рецепт збережено!'); window.showRecipeMainView(); renderMaterialsTable(); });
};
// ==========================================
// ЛОГИКА ИНТЕГРАЦИИ С MAKE (ETSY)
// ==========================================
let unsubscribeOrders = null;
function formatOrderDate(value) {
    if (!value) return '';
    try {
        let date = value.toDate ? value.toDate() : new Date(value);
        if (isNaN(date.getTime())) return '';
        // 1. Формируем дату заказа (MM/DD)
        const orderMonth = String(date.getMonth() + 1).padStart(2, '0');
        const orderDay = String(date.getDate()).padStart(2, '0');
        const orderDateStr = `${orderMonth}/${orderDay}`;
        // 2. Добавляем 3 дня для дедлайна
        let deadlineDate = new Date(date);
        deadlineDate.setDate(deadlineDate.getDate() + 3);
        // 3. Формируем дату дедлайна (MM/DD)
        const deadlineMonth = String(deadlineDate.getMonth() + 1).padStart(2, '0');
        const deadlineDay = String(deadlineDate.getDate()).padStart(2, '0');
        const deadlineDateStr = `${deadlineMonth}/${deadlineDay}`;
        // 4. Возвращаем две строки через тег переноса <br>
        return `${orderDateStr}<br>${deadlineDateStr}`;
    } catch (e) { return ''; }
}
function getDefaultStatusHtml() {
    let defaultStatus = menuData['status']?.find(s => s.text === 'Нове') || { text: 'Нове', class: 'badge-status', customStyle: 'background-color: #e3e2e0; color: #37352f;' };
    return `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;"><span class="badge ${defaultStatus.class || 'badge-status'}" style="${defaultStatus.customStyle || ''}">${defaultStatus.text}</span></div>`;
}
function getStatusHtml(statusText) {
    if (!statusText) return getDefaultStatusHtml();
    // Підтримка старих назв
    const aliases = {
        'Чекаю макет': 'Чекає макет',
        'В процесі': 'В роботі',
        'Виконано': 'Відправлено',
    };
    const normalized = aliases[statusText] || statusText;
    // Спочатку шукаємо в menuData.status (там актуальні кольори з Firebase)
    let statusItem = (menuData.status || []).find(s => s.text === normalized);
    // Fallback на FIXED_STATUSES
    if (!statusItem) statusItem = FIXED_STATUSES.find(s => s.text === normalized);
    if (!statusItem) return getDefaultStatusHtml();
    return `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;"><span class="badge ${statusItem.class || 'badge-status'}" style="${statusItem.customStyle || ''}">${statusItem.text}</span></div>`;
}
function getSourceHtml(sourceValue) {
    const sourceText = (sourceValue || '').trim();
    let sourceItem = menuData['source']?.find(s => (s.text || '').trim().toLowerCase() === sourceText.toLowerCase());
    if (!sourceItem) return `<div class="clamp-wrapper"><span>${sourceText}</span></div>`;
    return `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;"><span class="badge ${sourceItem.class || ''}" style="${sourceItem.customStyle || ''}">${sourceItem.text}</span></div>`;
}
const PRODUCT_ALIASES = {
    'Копілка': ['копілка', 'копилка', 'kopilka', 'piggy bank', 'money box', 'coin bank'],
    'Хотвілс': ['хотвілс', 'hotwheels', 'hot wheels', 'cars shelf', 'toy car holder'],
    'Іменна табличка': ['іменна табличка', 'именная табличка', 'name sign', 'wooden name sign', 'nursery sign']
};
function normalizeProductTitle(productValue) {
    const raw = String(productValue || '').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    for (const [finalName, aliases] of Object.entries(PRODUCT_ALIASES)) {
        if (finalName.toLowerCase() === lower || aliases.some(alias => alias.toLowerCase() === lower)) return finalName;
    }
    return raw;
}
function getProductHtml(productValue) {
    const normalized = normalizeProductTitle(productValue);
    let productItem = menuData['product']?.find(p => (p.text || '').trim().toLowerCase() === normalized.toLowerCase());
    if (!productItem) return `<div class="clamp-wrapper" style="text-align:center;">${normalized}</div>`;
    return `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;"><span class="badge ${productItem.class || 'badge-status'}" style="${productItem.customStyle || ''}">${productItem.text}</span></div>`;
}
function splitSmart(value) {
    if (!value) return [];
    return String(value).split(/\n|,/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/\s+/g, ' ').trim());
}
// Спеціальний рендер персоналізації для Хотвілс (формат "Табличка: x / Вантажівка: y")
window.formatHwPersHtml = function(rawVal) {
    if (!rawVal) return '<div class="clamp-wrapper"></div>';
    const lines = rawVal.split('\n').map(l => l.trim()).filter(Boolean);
    const isHwFormat = lines.some(l => l.startsWith('Табличка:') || l.startsWith('Вантажівка:'));
    if (!isHwFormat) {
        // Звичайний текст від Etsy — показуємо як є
        return `<div class="clamp-wrapper" style="width:100%; text-align:center;"><span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1; padding:2px 8px; font-size:12px; height:auto; white-space:normal; text-align:center;">${rawVal.replace(/\n/g, '<br>')}</span></div>`;
    }
    const displayHtml = lines.map(l => {
        const colonIdx = l.indexOf(': ');
        if (colonIdx === -1) return '';
        const title = l.slice(0, colonIdx);
        const val = l.slice(colonIdx + 2).trim();
        const textVal = (val === 'є' || val === '') ? 'Без тексту' : val.replace(/"/g, '&quot;');
        return `<div style="display:flex; flex-direction:column; margin-bottom:6px; align-items:center;"><div style="font-size:11px; color:var(--c-texSec); margin-bottom:2px; line-height:1; font-weight:400;">${title}</div><span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1; padding:2px 8px; font-size:12px; height:auto; min-height:24px; text-transform:none; font-weight:500; display:inline-block; max-width:100%; white-space:normal !important; line-height:1.2; text-align:center;">${textVal}</span></div>`;
    }).join('');
    return `<div class="clamp-wrapper" style="width:100%; display:flex; flex-direction:column; align-items:center;">${displayHtml}</div>`;
};
// === WISH TREE: рендер персоналізації ===
window.formatWtPersHtml = function(rawVal) {
    if (!rawVal) return '<div class="clamp-wrapper"></div>';
    const lines = rawVal.split('\n').map(l => l.trim()).filter(Boolean);
    const isWtFormat = lines.some(l => l.startsWith('Пара імен:') || l.startsWith('Прізвище:') || l.startsWith('Дата:'));
    if (!isWtFormat) {
        return `<div class="clamp-wrapper" style="width:100%; text-align:center;"><span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1; padding:2px 8px; font-size:12px; height:auto; white-space:normal; text-align:center;">${rawVal.replace(/\n/g, '<br>')}</span></div>`;
    }
    const makeBadge = (title, val) => `<div style="display:flex; flex-direction:column; margin-bottom:6px; align-items:center;"><div style="font-size:11px; color:var(--c-texSec); margin-bottom:2px; line-height:1; font-weight:400;">${title}</div><span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1; padding:2px 8px; font-size:12px; height:auto; min-height:24px; text-transform:none; font-weight:500; display:inline-block; max-width:100%; white-space:normal !important; line-height:1.2; text-align:center;">${val.replace(/"/g, '&quot;') || '—'}</span></div>`;
    const get = (prefix) => { const l = lines.find(l => l.startsWith(prefix + ':')); return l ? l.slice(prefix.length + 1).trim() : ''; };
    let html = '';
    const para = get('Пара імен'); if (para) html += makeBadge('Пара імен', para);
    const priz = get('Прізвище'); if (priz) html += makeBadge('Прізвище', priz);
    const data = get('Дата'); if (data) html += makeBadge('Дата', data);
    return `<div class="clamp-wrapper" style="width:100%; display:flex; flex-direction:column; align-items:center;">${html}</div>`;
};
// === WISH TREE: Popovers ===
// Рядок у wtPersPopover — аналог addHwPersRow
window.addWtPersRow = function(type, text) {
    const list = document.getElementById('wtPersInputList');
    const labels = { Para: 'Пара імен', Prizv: 'Прізвище', Data: 'Дата' };
    const placeholders = { Para: "Ім'я & Ім'я", Prizv: 'Прізвище', Data: 'дд.мм.рррр' };
    const label = labels[type] || type;
    const ph = placeholders[type] || '';
    const row = document.createElement('div'); row.className = 'pers-input-row'; row.id = 'wtRow' + type;
    row.innerHTML = `<div style="flex-shrink:0; width:80px; font-size:12px; color:var(--c-texPri); font-weight:500;">${label}</div><input type="text" id="wtInp${type}" value="${(text||'').replace(/"/g,'&quot;')}" placeholder="${ph}" onkeydown="if(event.key==='Enter'){event.preventDefault(); window.saveWtPers();}"><div class="del-pers-btn" onclick="this.parentElement.remove()" title="Видалити"><svg viewBox="0 0 16 16" style="width:14px;height:14px;fill:currentColor;"><path d="M12.642 3.358a.625.625 0 0 0-.884 0L8 7.116 4.242 3.358a.625.625 0 1 0-.884.884L7.116 8l-3.758 3.758a.625.625 0 0 0 .884.884L8 8.884l3.758 3.758a.625.625 0 1 0 .884-.884L8.884 8l3.758-3.758a.625.625 0 1 0 .884-.884L8.884 8l3.758-3.758a.625.625 0 0 0 0-.884"></path></svg></div>`;
    list.appendChild(row);
};
window.restoreWtFields = function() {
    if (!document.getElementById('wtRowPara'))  window.addWtPersRow('Para', '');
    if (!document.getElementById('wtRowPrizv')) window.addWtPersRow('Prizv', '');
    if (!document.getElementById('wtRowData'))  window.addWtPersRow('Data', '');
};
window.openWtPersPopover = function(td, rect) {
    closeAllPopovers(); currentEditingCell = td;
    let val = td.dataset.val || '';
    if (val.includes('<div') || val.includes('<span')) val = td.innerText.trim();
    const get = (prefix) => { const l = val.split('\n').find(l => l.trim().startsWith(prefix + ':')); return l ? l.slice(l.indexOf(':') + 1).trim() : ''; };
    const list = document.getElementById('wtPersInputList'); list.innerHTML = '';
    window.addWtPersRow('Para',  get('Пара імен'));
    window.addWtPersRow('Prizv', get('Прізвище'));
    window.addWtPersRow('Data',  get('Дата'));
    window.smartPosition(document.getElementById('wtPersPopover'), rect, 'over');
};
window.saveWtPers = function() {
    const parts = [];
    const para  = document.getElementById('wtInpPara')  ? document.getElementById('wtInpPara').value.trim()  : '';
    const prizv = document.getElementById('wtInpPrizv') ? document.getElementById('wtInpPrizv').value.trim() : '';
    const data  = document.getElementById('wtInpData')  ? document.getElementById('wtInpData').value.trim()  : '';
    if (para)  parts.push('Пара імен: ' + para);
    if (prizv) parts.push('Прізвище: ' + prizv);
    if (data)  parts.push('Дата: ' + data);
    const rawVal = parts.join('\n');
    if (!currentEditingCell) return;
    recordUndoState();
    currentEditingCell.dataset.val = rawVal;
    currentEditingCell.innerHTML = window.formatWtPersHtml(rawVal);
    saveData();
    if (typeof syncRowToDb === 'function') syncRowToDb(currentEditingCell.closest('tr'));
    closeAllPopovers();
};
window.openWtColorPopover = function(td, rect) {
    closeAllPopovers(); currentEditingCell = td;
    let current = td.dataset.val || td.innerText.trim();
    if (current.includes('<div') || current.includes('<span')) current = td.innerText.trim();
    let html = window.wtColors.map(c => `<div class="k-color-btn ${current === c.name ? 'active' : ''}" style="background-color: ${c.hex};" title="${c.name}" onclick="setWtColor('${c.name.replace(/'/g, "\\'")}')"></div>`).join('');
    document.getElementById('wtColorList').innerHTML = html;
    window.smartPosition(document.getElementById('wtColorPopover'), rect, 'over');
};
window.setWtColor = function(colorName) {
    recordUndoState();
    let colorObj = window.wtColors.find(c => c.name === colorName);
    let inner = `<span style="display:inline-block; min-width:10px; width:10px; height:10px; background-color:${colorObj.hex}; border:1px solid rgba(0,0,0,0.15); border-radius:50%; margin-right:5px; flex-shrink:0;"></span><span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${colorName}</span>`;
    const topLabel = `<div style="font-size:10px; color:var(--c-texSec); font-weight:500; margin-bottom:3px; line-height:1; text-align:center;">Стенд</div>`;
    let badgeHtml = `<span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1;">${inner}</span>`;
    currentEditingCell.dataset.val = colorName;
    currentEditingCell.innerHTML = `<div class="clamp-wrapper" style="align-items:center; display:flex; flex-direction:column; justify-content:center; height:100%; width:100%;">${topLabel}${badgeHtml}</div>`;
    saveData(); closeAllPopovers();
    if (typeof syncRowToDb === 'function') syncRowToDb(currentEditingCell.closest('tr'));
};
window.openWtSizePopover = function(td, rect) {
    closeAllPopovers(); currentEditingCell = td;
    let current = td.dataset.val || td.innerText.trim();
    if (current.includes('<div') || current.includes('<span')) current = td.innerText.trim();
    let html = window.wtSizes.map(s => `<button class="k-size-btn ${current === s ? 'active' : ''}" onclick="setWtSize('${s}')">${s}</button>`).join('');
    document.getElementById('wtSizeList').innerHTML = html;
    window.smartPosition(document.getElementById('wtSizePopover'), rect, 'over');
};
window.setWtSize = function(size) {
    recordUndoState();
    currentEditingCell.dataset.val = size;
    let badgeHtml = `<span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1;">${size}</span>`;
    currentEditingCell.innerHTML = `<div class="clamp-wrapper" style="align-items:center; display:flex; justify-content:center; height:100%; width:100%;">${badgeHtml}</div>`;
    saveData(); closeAllPopovers();
    if (typeof syncRowToDb === 'function') syncRowToDb(currentEditingCell.closest('tr'));
};
window.formatPersHtml = function(inputsArray) {
    if (!inputsArray || inputsArray.length === 0) return '<div class="clamp-wrapper"></div>';
    let displayHtml = inputsArray.map(v => {
        let textVal = v.replace(/"/g, '&quot;');
        return `<div class="multi-val-row" style="justify-content: center;"><span class="badge" style="background:white; color:var(--c-texPri); border:1px solid #d1d1d1; padding:2px 8px; font-size:12px; height:auto; min-height:22px; line-height:1.2; text-transform:none; font-weight:500; display:inline-block; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:center;" title="${textVal}">${textVal}</span></div>`;
    }).join('');
    return `<div class="clamp-wrapper" style="width:100%; text-align:center;">${displayHtml}</div>`;
}
// Рендер дизайну для Хотвілс при завантаженні з бази
function renderHwDesignFromVal(rawVal) {
    if (!rawVal) return '<div class="clamp-wrapper"></div>';
    let design = rawVal, shelf = '';
    if (rawVal.includes(' | Поличка: ')) {
        const parts = rawVal.split(' | Поличка: ');
        design = parts[0].trim();
        shelf  = parts[1].trim();
    }
    if (typeof window.renderHwDesignHtml === 'function') {
        return window.renderHwDesignHtml(design, shelf);
    }
    return `<div class="clamp-wrapper" style="text-align:center;">${rawVal}</div>`;
}
function createRowFromOrder(orderDocId, order) {
    if (!tbody || tbody.querySelector(`tr[data-order-id="${orderDocId}"]`)) return;
    const row = document.createElement('tr');
    row.dataset.orderId = orderDocId;
    row.dataset.sortOrder = order.sortOrder ?? 0;
    if (order.orderNumber) row.dataset.orderNumber = order.orderNumber;
    if (order.hiddenFromFinances) row.dataset.hiddenFromFinances = 'true';
    if (order.rawHtml) {
        // Точне відновлення з оригінального HTML
        const tmp = document.createElement('tbody');
        tmp.innerHTML = order.rawHtml;
        const origRow = tmp.querySelector('tr');
        if (origRow) {
            Array.from(origRow.attributes).forEach(attr => {
                if (attr.name !== 'data-order-id' && attr.name !== 'data-sort-order') row.setAttribute(attr.name, attr.value);
            });
            row.dataset.sortOrder = order.sortOrder ?? 0;
            row.innerHTML = origRow.innerHTML;
        }
        
        tbody.prepend(row);
        
        // НОВЕ: Одразу накладаємо свіжі дані з бази поверх старого HTML
        updateRowFromOrder(orderDocId, order);
        
    } else {
        if (order.priceUsd)    row.dataset.priceUsd    = order.priceUsd;
        if (order.deliveryUsd) row.dataset.deliveryUsd = order.deliveryUsd;
        if (order.shipEmail)   row.dataset.shipEmail   = order.shipEmail;
        if (order.shipPhone)   row.dataset.shipPhone   = order.shipPhone;
        const dateVal = order.dateText ? `<span>${order.dateText.replace(' - ', '<br>').replace(/\s*\n\s*/g, '<br>')}</span>` : formatOrderDate(order.createdAt);
        const statusHtml = getStatusHtml(order.status);
        const personalizationArray = splitSmart(order.personalizationText);
        const colorArray = splitSmart(order.color);
        const sizeArray = splitSmart(order.size);
        const designArray = splitSmart(order.design);
        
        const personalizationVal = personalizationArray.join('\n');
        const colorVal = colorArray.join('\n');
        const sizeVal = sizeArray.join('\n');
        const designVal = designArray.join('\n');
        const isHwOrder = (normalizeProductTitle(order.productTitle || '')).toLowerCase().includes('хот') || (order.productTitle || '').toLowerCase().includes('hot');
        const isWtOrder = (normalizeProductTitle(order.productTitle || '')).toLowerCase().includes('wish tree') || (order.productTitle || '').toLowerCase().includes('wish tree');
        const personalizationHtml = isHwOrder ? window.formatHwPersHtml(personalizationVal) : isWtOrder ? window.formatWtPersHtml(personalizationVal) : window.formatPersHtml(personalizationArray);
        const baseArray = (isHwOrder || isWtOrder) ? ['single'] : (personalizationArray.length ? personalizationArray : ['?']);
        const colorHtml = window.formatMultiRowHtml ? window.formatMultiRowHtml(baseArray, colorArray, '?', 'color') : '';
        const sizeHtml = window.formatMultiRowHtml ? window.formatMultiRowHtml(baseArray, sizeArray, '?') : '';
        const designHtml = isHwOrder ? renderHwDesignFromVal(designVal) : isWtOrder ? '<div class="clamp-wrapper"></div>' : (window.formatMultiRowHtml ? window.formatMultiRowHtml(baseArray, designArray, '?') : '');
        row.innerHTML = `
            <td class="cell-checkbox no-print"><span class="row-num"></span><input type="checkbox" class="row-checkbox"></td>
            <td class="select-cell" data-type="source">${getSourceHtml(order.source)}</td>
            <td class="date-cell" data-type="date">${dateVal}</td>
            <td class="text-cell copyable-cell" data-type="name"><div class="clamp-wrapper">${order.customerName || ''}</div></td>
            <td class="select-cell" data-type="product" data-val="${normalizeProductTitle(order.productTitle || '')}">${getProductHtml(order.productTitle || '')}</td>
            <td class="text-cell" data-type="pers" data-val="${personalizationVal}">${personalizationHtml}</td>
            <td class="select-cell" data-type="color" data-val="${colorVal}">${colorHtml}</td>
            <td class="select-cell" data-type="size" data-val="${sizeVal}">${sizeHtml}</td>
            <td class="text-cell" data-type="design" data-val="${designVal}">${designHtml}</td>
            <td class="text-cell copyable-cell" data-type="recipient" data-val="${order.recipientAddress || ''}"><div class="clamp-wrapper" style="text-align:center;"></div></td>
            <td class="select-cell" data-type="status">${statusHtml}</td>
            <td class="text-cell copyable-cell" data-type="tracking"><div class="clamp-wrapper">${order.trackingCode || ''}</div></td>
            <td class="image-cell" data-type="layout">${order.imageLayout ? `<div class="img-cell-wrap" data-dxf="${order.dxfUrl || ''}"><div class="img-wrapper"><img src="${order.imageLayout}" loading="lazy"><div class="img-actions no-print"><button class="img-btn view-btn" title="Переглянути"><svg viewBox="0 0 16 16"><path d="M2 2v4h1.5V3.5H7V2H2zm12 0h-5v1.5h3.5V7H14V2zM2 14h5v-1.5H3.5V9H2v5zm12 0V9h-1.5v3.5H9V14h5z"></path></svg></button>${currentUser === 'матвій' ? `<button class="img-btn delete-btn" title="Видалити"><svg viewBox="0 0 16 16"><path d="M3.2 4.8h9.6l-.8 8.8c-.1.8-.8 1.6-1.6 1.6H5.6c-.8 0-1.5-.8-1.6-1.6l-.8-8.8zm2.4 8h1.6V6.4H5.6V12.8zm3.2 0h1.6V6.4H8.8V12.8zM4.8 3.2V1.6C4.8.7 5.5 0 6.4 0h3.2c.9 0 1.6.7 1.6 1.6v1.6h3.2v1.6H1.6V3.2h3.2zM6.4 1.6v1.6h3.2V1.6H6.4z"></path></svg></button>` : ''}</div></div><button class="img-dl-btn no-print" title="Завантажити файл проекту" onclick="downloadLayout(this)"><svg viewBox="0 0 16 16"><path d="M8 11.5l-4.5-4.5h3V2h3v5h3L8 11.5zM2 13.5v1h12v-1H2z"/></svg></button></div>` : '<span class="img-placeholder">+ Додати</span>'}</td>`;
        
        tbody.prepend(row);
    } 
    
    if (order.recipientAddress && !order.rawHtml) {
        const recipientTd = row.querySelector('td[data-type="recipient"]');
        if (recipientTd && typeof window.renderRecipientCell === 'function') {
            window.renderRecipientCell(recipientTd, order.recipientAddress);
        }
    }
    
    if (typeof applyFilters === 'function') applyFilters();
    if (typeof updateTodayHighlights === 'function') updateTodayHighlights();
    if (typeof updateAllUnreadDots === 'function') updateAllUnreadDots();
    if (typeof updateRowNumbers === 'function') updateRowNumbers();
    // Перевірка матеріалів для нового замовлення
    if (typeof window.applyMaterialWarningsToRow === 'function') window.applyMaterialWarningsToRow(row);
}
function updateRowFromOrder(orderDocId, order) {
    const row = tbody?.querySelector(`tr[data-order-id="${orderDocId}"]`);
    if (!row) return;
    // Відображаємо закріплений номер замовлення з Firebase
    if (order.orderNumber !== undefined) {
        row.dataset.orderNumber = order.orderNumber;
        const numSpan = row.querySelector('.row-num');
        if (numSpan) numSpan.innerText = order.orderNumber;
    }
    const nameCell = row.querySelector('[data-type="name"] .clamp-wrapper');
    const productCellWrap = row.querySelector('[data-type="product"]');
    const trackingCell = row.querySelector('[data-type="tracking"] .clamp-wrapper');
    const colorCell = row.querySelector('[data-type="color"]');
    const sizeCell = row.querySelector('[data-type="size"]');
    const designCell = row.querySelector('[data-type="design"]');
    const recipientCell = row.querySelector('[data-type="recipient"] .clamp-wrapper');
    const persTd = row.querySelector('[data-type="pers"]');
    const recipientTd = row.querySelector('[data-type="recipient"]');
    const sourceCell = row.querySelector('[data-type="source"]');
    const dateCell = row.querySelector('[data-type="date"]');
    if (nameCell && order.customerName !== undefined) {
        nameCell.textContent = order.customerName;
        nameCell.parentElement.dataset.val = order.customerName;
    }
    if (sourceCell && order.source !== undefined) {
        sourceCell.dataset.val = order.source;
        sourceCell.innerHTML = getSourceHtml(order.source);
    }
    if (dateCell && order.dateText !== undefined) {
        dateCell.innerHTML = order.dateText.replace(' - ', '<br>').replace(/\s*\n\s*/g, '<br>');
    }
    if (productCellWrap && order.productTitle !== undefined) {
        const normalizedProduct = normalizeProductTitle(order.productTitle || '');
        productCellWrap.dataset.val = normalizedProduct;
        productCellWrap.innerHTML = getProductHtml(normalizedProduct);
    }
    if (trackingCell && order.trackingCode !== undefined) {
        trackingCell.textContent = order.trackingCode || '';
        trackingCell.parentElement.dataset.val = order.trackingCode;
    }
    if (recipientTd && order.recipientAddress !== undefined) {
        recipientTd.dataset.val = order.recipientAddress;
        if (typeof window.renderRecipientCell === 'function') {
            window.renderRecipientCell(recipientTd, order.recipientAddress);
        } else {
            recipientTd.innerHTML = `<div class="clamp-wrapper">${order.recipientAddress.replace(/\n/g, '<br>')}</div>`;
        }
    }
    const isHwOrder = (normalizeProductTitle(order.productTitle || '')).toLowerCase().includes('хот') || (order.productTitle || '').toLowerCase().includes('hot');
    const isWtOrderUpd = (normalizeProductTitle(order.productTitle || '')).toLowerCase().includes('wish tree') || (order.productTitle || '').toLowerCase().includes('wish tree');
    
    if (persTd && order.personalizationText !== undefined) {
        const pArray = splitSmart(order.personalizationText);
        const persVal = pArray.join('\n');
        persTd.dataset.val = persVal;
        persTd.innerHTML = isHwOrder
            ? window.formatHwPersHtml(persVal)
            : isWtOrderUpd
                ? window.formatWtPersHtml(persVal)
                : window.formatPersHtml(pArray);
    }
    const baseArray = (isHwOrder || isWtOrderUpd) ? ['single'] : splitSmart(order.personalizationText || persTd?.dataset.val || '?');
    if (colorCell && order.color !== undefined) {
        const colorArray = splitSmart(order.color);
        colorCell.dataset.val = colorArray.join('\n');
        if (window.formatMultiRowHtml) colorCell.innerHTML = window.formatMultiRowHtml(baseArray, colorArray, '?', 'color');
    }
    if (sizeCell && order.size !== undefined) {
        const sizeArray = splitSmart(order.size);
        sizeCell.dataset.val = sizeArray.join('\n');
        if (window.formatMultiRowHtml) sizeCell.innerHTML = window.formatMultiRowHtml(baseArray, sizeArray, '?');
    }
    if (designCell && order.design !== undefined) {
        const designArray = splitSmart(order.design);
        designCell.dataset.val = designArray.join('\n');
        designCell.innerHTML = isHwOrder
            ? renderHwDesignFromVal(designArray.join(' '))
            : isWtOrderUpd
                ? '<div class="clamp-wrapper"></div>'
                : (window.formatMultiRowHtml ? window.formatMultiRowHtml(baseArray, designArray, '?') : '');
    }
    const statusCell = row.querySelector('[data-type="status"]');
    if (statusCell && order.status !== undefined) {
        statusCell.innerHTML = getStatusHtml(order.status);
        statusCell.dataset.val = order.status;
    }
    if (order.priceUsd !== undefined)    row.dataset.priceUsd    = order.priceUsd;
    if (order.deliveryUsd !== undefined) row.dataset.deliveryUsd = order.deliveryUsd;
    if (order.shipEmail)                 row.dataset.shipEmail   = order.shipEmail;
    if (order.shipPhone)                 row.dataset.shipPhone   = order.shipPhone;
    const layoutCell = row.querySelector('[data-type="layout"]');
    if (layoutCell && order.imageLayout !== undefined) {
        const imgSrc = order.imageLayout;
        if (imgSrc) {
            const _delBtn3 = currentUser === 'матвій' ? `<button class="img-btn delete-btn" title="Видалити"><svg viewBox="0 0 16 16"><path d="M3.2 4.8h9.6l-.8 8.8c-.1.8-.8 1.6-1.6 1.6H5.6c-.8 0-1.5-.8-1.6-1.6l-.8-8.8zm2.4 8h1.6V6.4H5.6V12.8zm3.2 0h1.6V6.4H8.8V12.8zM4.8 3.2V1.6C4.8.7 5.5 0 6.4 0h3.2c.9 0 1.6.7 1.6 1.6v1.6h3.2v1.6H1.6V3.2h3.2zM6.4 1.6v1.6h3.2V1.6H6.4z"></path></svg></button>` : '';
            layoutCell.innerHTML = `<div class="img-cell-wrap" data-dxf="${order.dxfUrl || ''}"><div class="img-wrapper"><img src="${imgSrc}" loading="lazy"><div class="img-actions no-print"><button class="img-btn view-btn" title="Переглянути"><svg viewBox="0 0 16 16"><path d="M2 2v4h1.5V3.5H7V2H2zm12 0h-5v1.5h3.5V7H14V2zM2 14h5v-1.5H3.5V9H2v5zm12 0V9h-1.5v3.5H9V14h5z"></path></svg></button>${_delBtn3}</div></div><button class="img-dl-btn no-print" title="Завантажити файл проекту" onclick="downloadLayout(this)"><svg viewBox="0 0 16 16"><path d="M8 11.5l-4.5-4.5h3V2h3v5h3L8 11.5zM2 13.5v1h12v-1H2z"/></svg></button></div>`;
        } else {
            layoutCell.innerHTML = '<span class="img-placeholder">+ Додати</span>';
        }
    }
    // Оновлюємо попередження про матеріали після оновлення рядка
    if (typeof window.applyMaterialWarningsToRow === 'function') window.applyMaterialWarningsToRow(row);
}
let _ordersShowAll = false;
function startOrdersSync() {
    if (unsubscribeOrders) unsubscribeOrders();
    // Завантажуємо всі замовлення — фільтрація на клієнті (без індексу Firestore)
    unsubscribeOrders = db.collection("orders").orderBy("sortOrder").onSnapshot((snapshot) => {
        if (!snapshot.empty) {
            window._migratedToOrders = true;
            const btn = document.getElementById('btnMigrate');
            if (btn) btn.style.display = 'none';
        }
        let needsUpdate = false;
        let hasAdded = false;
        snapshot.docChanges().forEach((change) => {
            const order = change.doc.data() || {};
            if (change.type === 'added') {
                createRowFromOrder(change.doc.id, order);
                // Одразу ховаємо "Відправлено" якщо не showAll
                if (!_ordersShowAll && order.status === 'Відправлено') {
                    const row = document.querySelector(`tr[data-order-id="${change.doc.id}"]`);
                    if (row) { row.style.display = 'none'; row.dataset.shipped = '1'; }
                }
                hasAdded = true;
            }
            if (change.type === 'modified') {
                updateRowFromOrder(change.doc.id, order);
            }
            if (change.type === 'removed') {
                const rowToRemove = document.querySelector(`tr[data-order-id="${change.doc.id}"]`);
                if (rowToRemove) { rowToRemove.remove(); needsUpdate = true; }
            }
        });
        if (hasAdded) {
            const rows = Array.from(tbody.querySelectorAll('tr'));
            rows.sort((a, b) => (parseInt(b.dataset.sortOrder||0)) - (parseInt(a.dataset.sortOrder||0)));
            rows.forEach(r => tbody.appendChild(r));
        }
        if (needsUpdate || hasAdded) {
            if (typeof updateRowNumbers === 'function') updateRowNumbers();
            if (typeof updateTodayHighlights === 'function') updateTodayHighlights();
            if (typeof updateAllUnreadDots === 'function') updateAllUnreadDots();
            wbfApplyShippedFilter();
            // Один раз — присвоюємо номери замовленням без orderNumber
            if (hasAdded && !window._orderMigrationDone) {
                window._orderMigrationDone = true;
                setTimeout(() => migrateOrderNumbers(), 1500);
            }
        }
    });
}
// Ховає/показує рядки зі статусом "Відправлено"
function wbfApplyShippedFilter() {
    let shippedCount = 0;
    document.querySelectorAll('#tableBody tr').forEach(row => {
        const badge = row.querySelector('td[data-type="status"] .badge');
        const status = badge?.innerText?.trim() || row.querySelector('td[data-type="status"]')?.dataset?.val || '';
        if (status === 'Відправлено') {
            row.style.display = _ordersShowAll ? '' : 'none';
            row.dataset.shipped = '1';
            shippedCount++;
        } else {
            row.dataset.shipped = '0';
        }
    });
    if (typeof applyFilters === 'function') applyFilters();
}
window.wbfUpdateShowAllBtn = function() {};
window.syncRowToDb = function(row) {
    if (!row) return;
    const orderId = row.dataset.orderId;
    const getVal = (dataType) => {
        const cell = row.querySelector(`td[data-type="${dataType}"]`);
        if (!cell) return '';
        // Для статусу — читаємо текст бейджа напряму (найнадійніший спосіб)
        if (dataType === 'status') {
            const badge = cell.querySelector('.badge');
            if (badge && badge.innerText.trim()) return badge.innerText.trim();
            if (cell.dataset.val) return cell.dataset.val;
            return cell.innerText.trim();
        }
        let val = cell.dataset.val !== undefined ? cell.dataset.val : cell.innerText.trim();
        if(val.includes('<div') || val.includes('<span')) {
            const temp = document.createElement('div');
            temp.innerHTML = val;
            val = temp.innerText.trim();
        }
        return val;
    };
    const imgCell = row.querySelector('td[data-type="layout"]');
    const img = imgCell ? imgCell.querySelector('img') : null;
    const dateCell = row.querySelector('td[data-type="date"]');
    const dateText = (() => {
        if (!dateCell) return '';
        const html = dateCell.innerHTML;
        const tmp = document.createElement('div');
        tmp.innerHTML = html.replace(/<br\s*\/?>/gi, ' - ');
        return tmp.innerText.trim().replace(/\s+/g, ' ').replace(' -  - ', ' - ');
    })();
    const updateData = {
        status:              getVal('status'),
        trackingCode:        getVal('tracking'),
        customerName:        getVal('name'),
        source:              getVal('source'),
        productTitle:        getVal('product'),
        personalizationText: getVal('pers'),
        color:               getVal('color'),
        size:                getVal('size'),
        design:              getVal('design'),
        recipientAddress:    (() => {
            const cell = row.querySelector('td[data-type="recipient"]');
            return cell ? (cell.dataset.val || '') : '';
        })(),
        priceUsd:            parseFloat(row.dataset.priceUsd)    || 0,
        deliveryUsd:         parseFloat(row.dataset.deliveryUsd) || 0,
        shipEmail:           row.dataset.shipEmail || '',
        shipPhone:           row.dataset.shipPhone || '',
        dateText:            dateText,
        history:             (() => { try { return JSON.parse(row.dataset.history || '[]'); } catch(e) { return []; } })(),
        updatedAt:           firebase.firestore.FieldValue.serverTimestamp(),
    };
    // НОВЕ: Завжди зберігаємо свіжий rawHtml рядка (очищений від тимчасових класів)
    const clone = row.cloneNode(true);
    clone.classList.remove('selected', 'dragging', 'highlight-today', 'hidden-by-pagination');
    clone.style.display = '';
    const cb = clone.querySelector('input.row-checkbox');
    if (cb) { cb.checked = false; cb.removeAttribute('checked'); }
    updateData.rawHtml = clone.outerHTML;
    if (img) updateData.imageLayout = img.src;
    if (row.dataset.sortOrder) updateData.sortOrder = parseInt(row.dataset.sortOrder);
    if (!orderId) {
        updateData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        getNextOrderNumber().then(orderNum => {
            updateData.orderNumber = orderNum;
            db.collection("orders").add(updateData).then(docRef => {
                row.dataset.orderId = docRef.id;
                row.dataset.orderNumber = orderNum;
                const numSpan = row.querySelector('.row-num');
                if (numSpan) numSpan.innerText = orderNum;
            }).catch(err => console.error("Помилка створення замовлення:", err));
        }).catch(err => {
            console.warn("getNextOrderNumber failed:", err);
            db.collection("orders").add(updateData).then(docRef => {
                row.dataset.orderId = docRef.id;
            }).catch(err2 => console.error("Помилка створення замовлення:", err2));
        });
    } else {
        db.collection("orders").doc(orderId).update(updateData)
            .catch(err => console.error("Помилка оновлення замовлення:", err));
    }
}
// ====== БЕКАП / ВІДКАТ ======
window.createBackup = async function() {
    const rows = document.querySelectorAll('#tableBody tr');
    if (!confirm(`Зберегти бекап таблиці (${rows.length} рядків)?\nМожна буде відкатити будь-коли.`)) return;
    const snap = {
        html: document.getElementById('tableBody').innerHTML,
        menu: JSON.parse(JSON.stringify(menuData)),
        savedAt: Date.now(),
        rowCount: rows.length,
        label: new Date().toLocaleString('uk-UA')
    };
    await db.collection("babak_crm").doc("backup_latest").set(snap);
    showToast(`✓ Бекап збережено: ${snap.label}`);
};
window.restoreBackup = async function() {
    const doc = await db.collection("babak_crm").doc("backup_latest").get();
    if (!doc.exists || !doc.data().html) {
        showToast('Бекап не знайдено');
        return;
    }
    const data = doc.data();
    const age = Math.round((Date.now() - data.savedAt) / 60000);
    if (!confirm(`Відкатити до бекапу від ${data.label}?\n(${age} хв тому, ${data.rowCount} рядків)\n\nПОТОЧНИЙ СТАН БУДЕ ЗАМІНЕНО!`)) return;
    document.getElementById('tableBody').innerHTML = data.html;
    if (data.menu) { Object.assign(menuData, data.menu); }
    saveData();
    applyFilters();
    updateRowNumbers();
    updateTodayHighlights();
    showToast(`✓ Відкатили до ${data.label}`);
};
// ====== МІГРАЦІЯ: HTML → структуровані orders ======
window.migrateHtmlToOrders = async function() {
    if (!confirm(`Мігрувати всі замовлення в колекцію orders?\n\nДані читаються прямо з Firebase.\nПісля міграції сторінка перезавантажиться.`)) return;
    // Зупиняємо listeners
    if (typeof unsubscribe === 'function') unsubscribe();
    if (typeof unsubscribeOrders === 'function') unsubscribeOrders();
    showToast('Читаємо дані з Firebase...');
    // 1. Читаємо HTML з main_state (не з DOM!)
    const mainDoc = await db.collection("babak_crm").doc("main_state").get();
    if (!mainDoc.exists || !mainDoc.data().html) {
        showToast('Помилка: main_state не знайдено'); return;
    }
    // 2. Парсимо в тимчасовий DOM
    const tmpDiv = document.createElement('tbody');
    tmpDiv.innerHTML = mainDoc.data().html;
    const rows = Array.from(tmpDiv.querySelectorAll('tr'));
    if (rows.length === 0) { showToast('Немає рядків'); return; }
    // 3. Очищаємо orders
    showToast('Очищення...');
    const existing = await db.collection("orders").get();
    if (!existing.empty) {
        const batch = db.batch();
        existing.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
    }
    showToast(`Міграція ${rows.length} рядків...`);
    // 4. Зберігаємо кожен рядок — rawHtml для точного відновлення
    //    + мінімум структурних полів для пошуку і фінансів
    const total = rows.length;
    let done = 0;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        // Чистимо стан перед збереженням (прибираємо selected/checkbox)
        row.classList.remove('selected');
        const cb = row.querySelector('input.row-checkbox');
        if (cb) { cb.checked = false; cb.removeAttribute('checked'); }
        const getVal = (dataType) => {
            const cell = row.querySelector(`td[data-type="${dataType}"]`);
            if (!cell) return '';
            let val = cell.dataset.val !== undefined ? cell.dataset.val : cell.innerText.trim();
            if (val.includes('<') ) { const t = document.createElement('div'); t.innerHTML = val; val = t.innerText.trim(); }
            return val;
        };
        const orderData = {
            rawHtml:      row.outerHTML,           // ← точний HTML рядка
            sortOrder:    total - i,               // верхній = total, нижній = 1
            // структурні поля для пошуку/фінансів:
            status:       getVal('status') || 'Нове',
            customerName: getVal('name'),
            productTitle: getVal('product'),
            trackingCode: getVal('tracking'),
            priceUsd:     parseFloat(row.dataset.priceUsd)    || 0,
            deliveryUsd:  parseFloat(row.dataset.deliveryUsd) || 0,
            history:      (() => { try { return JSON.parse(row.dataset.history || '[]'); } catch(e) { return []; } })(),
            migratedFromHtml: true,
            createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
        };
        await db.collection("orders").add(orderData);
        done++;
        if (done % 5 === 0) showToast(`Мігровано ${done}/${total}...`);
    }
    showToast(`✓ Готово! ${done} замовлень. Перезавантаження...`);
    setTimeout(() => location.reload(), 1500);
};
// ==========================================
initAuth();
// ====== DRAG & DROP ДЛЯ МАТВІЯ ======
function initDragAndDrop() {
    if (currentUser !== 'матвій') return;
    let dragSrc = null;
    const dragIndicator = document.createElement('div');
    dragIndicator.style.cssText = 'position:fixed;height:2px;background:#2383e2;border-radius:2px;pointer-events:none;z-index:99999;display:none;box-shadow:0 0 6px rgba(35,131,226,0.5);';
    document.body.appendChild(dragIndicator);
    function addHandleToRow(row) {
        if (row.querySelector('.drag-handle')) return;
        const checkboxTd = row.querySelector('.cell-checkbox');
        if (!checkboxTd) return;
        const handle = document.createElement('div');
        handle.className = 'drag-handle';
        handle.title = 'Перетягнути';
        handle.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="5.5" cy="4" r="1.2"/><circle cx="10.5" cy="4" r="1.2"/><circle cx="5.5" cy="8" r="1.2"/><circle cx="10.5" cy="8" r="1.2"/><circle cx="5.5" cy="12" r="1.2"/><circle cx="10.5" cy="12" r="1.2"/></svg>`;
        checkboxTd.appendChild(handle);
        handle.addEventListener('mousedown', e => { e.stopPropagation(); row.setAttribute('draggable', 'true'); });
        handle.addEventListener('mouseup', () => row.setAttribute('draggable', 'false'));
    }
    tbody.querySelectorAll('tr').forEach(addHandleToRow);
    new MutationObserver(mutations => {
        mutations.forEach(m => m.addedNodes.forEach(n => { if (n.nodeName === 'TR') addHandleToRow(n); }));
    }).observe(tbody, { childList: true });
    tbody.addEventListener('dragstart', e => {
        const row = e.target.closest('tr');
        if (!row) return;
        dragSrc = row;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
    });
    tbody.addEventListener('dragend', e => {
        const row = e.target.closest('tr');
        if (row) { row.classList.remove('dragging'); row.setAttribute('draggable', 'false'); }
        dragSrc = null;
        dragIndicator.style.display = 'none';
    });
    tbody.addEventListener('dragover', e => {
        e.preventDefault();
        const targetRow = e.target.closest('tr');
        if (!targetRow || targetRow === dragSrc) { dragIndicator.style.display = 'none'; return; }
        const rect = targetRow.getBoundingClientRect();
        const tableRect = targetRow.closest('table')?.getBoundingClientRect() || rect;
        const isAbove = e.clientY < rect.top + rect.height / 2;
        dragIndicator.style.display = 'block';
        dragIndicator.style.left = tableRect.left + 'px';
        dragIndicator.style.width = tableRect.width + 'px';
        dragIndicator.style.top = (isAbove ? rect.top : rect.bottom) - 1 + 'px';
        dragIndicator._insertBefore = isAbove ? targetRow : targetRow.nextSibling;
    });
    tbody.addEventListener('dragleave', e => {
        if (!tbody.contains(e.relatedTarget)) dragIndicator.style.display = 'none';
    });
    tbody.addEventListener('drop', e => {
        e.preventDefault();
        if (!dragSrc || !dragIndicator._insertBefore) { dragIndicator.style.display = 'none'; return; }
        const insertBefore = dragIndicator._insertBefore;
        if (insertBefore === dragSrc || insertBefore === dragSrc.nextSibling) { dragIndicator.style.display = 'none'; return; }
        tbody.insertBefore(dragSrc, insertBefore);
        dragIndicator.style.display = 'none';
        saveSortOrderToFirebase();
    });
}
function saveSortOrderToFirebase() {
    const rows = Array.from(tbody.querySelectorAll('tr[data-order-id]'));
    const total = rows.length;
    const updates = rows.map((row, index) => {
        const newSort = total - index;
        row.dataset.sortOrder = newSort;
        const orderId = row.dataset.orderId;
        if (!orderId) return Promise.resolve();
        return db.collection('orders').doc(orderId).set({ sortOrder: newSort }, { merge: true });
    });
    Promise.all(updates)
        .then(() => { updateRowNumbers(); showToast('Порядок збережено'); })
        .catch(err => console.error('Помилка збереження порядку:', err));
}
// =====================================================
// ===== WESTERN BID API — WB TAB =====
// =====================================================
const WB_PROXY = 'https://europe-west1-babakteam-b9ac4.cloudfunctions.net/wbProxy';
async function wbRequest(method, path, body) {
    const res = await fetch(WB_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, path, body: body || null })
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }
    if (!res.ok) {
        const msg = data?.ErrorMessage || data?.Message || data?.error || JSON.stringify(data).slice(0, 300);
        throw new Error(msg);
    }
    return data;
}
// --- Transliteration for latin description ---
function wbSafeDesc(str) {
    const map = {
        'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','є':'ye','ж':'zh','з':'z',
        'и':'i','й':'y','і':'i','ї':'yi','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p',
        'р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch',
        'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
    };
    return str.split('').map(c => {
        const l = c.toLowerCase();
        const t = map[l];
        if (t === undefined) return c;
        return c === c.toUpperCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t;
    }).join('');
}
// --- Pick mode: вибір замовлення зі списку ---
window.wbPickOrder = function() {
    switchView('ordersView');
    showToast('Клікніть на рядок замовлення для вибору');
    window._wbPickMode = true;
};
// Підключаємо pick mode до кліку на recipient клітинку
(function patchClickForWb() {
    document.addEventListener('click', function(e) {
        if (!window._wbPickMode) return;
        const td = e.target.closest('td');
        if (!td) return;
        const row = td.closest('tr');
        if (!row || !row.dataset.orderId) return;
        window._wbPickMode = false;
        e.stopPropagation();
        e.preventDefault();
        window.wbFillPanelFromRow(row);
        switchView('wbView');
        showToast('✅ Замовлення вибрано');
    }, true);
})();
// --- Заповнити панель даними з рядка ---
window.wbFillPanelFromRow = function(row) {
    if (!row) return;
    window._wbSelectedRow = row;
    window._shippingRow   = row;
    const d = row.dataset;
    const prodCell = row.querySelector('td[data-type="product"]');
    const prodTitle = prodCell?.dataset?.val || prodCell?.textContent?.trim() || '';
    const info = document.getElementById('wbOrderInfo');
    if (info) info.textContent = prodTitle || d.orderId || '—';
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    set('wb_shipName',    d.shipName);
    set('wb_shipEmail',   d.shipEmail);
    set('wb_shipPhone',   d.shipPhone);
    set('wb_shipCountry', d.shipCountry || 'US');
    set('wb_shipCity',    d.shipCity);
    set('wb_shipState',   d.shipState);
    set('wb_shipZip',     d.shipZip);
    set('wb_shipStreet',  d.shipStreet);
    set('wb_shipHouse',   d.shipHouse);
    set('wb_shipLength',  d.shipLength);
    set('wb_shipWidth',   d.shipWidth);
    set('wb_shipHeight',  d.shipHeight);
    set('wb_shipWeight',  d.shipWeight);
    set('shipHsCode',     d.shipHsCode);
    set('shipDescRu',     d.shipDescRu);
    set('shippingPrice',  d.priceUsd);
    set('shippingDelivery', d.deliveryUsd);
    // Скидаємо результати
    const rr = document.getElementById('wbRatesResult');
    if (rr) { rr.style.display = 'none'; rr.innerHTML = ''; }
    const sr = document.getElementById('wbSelectedRate');
    if (sr) sr.style.display = 'none';
    const cb = document.getElementById('wbCreateBtn');
    if (cb) cb.style.display = 'none';
    window._wbSelectedRateObj = null;
};
// --- Синхронізувати wb_* поля → dataset рядка і в "стандартні" id для wbGetRates ---
window.wbSyncPanelToRow = function() {
    const row = window._wbSelectedRow || window._shippingRow;
    if (!row) return;
    const pairs = [
        ['wb_shipName','shipName'],['wb_shipEmail','shipEmail'],['wb_shipPhone','shipPhone'],
        ['wb_shipCountry','shipCountry'],['wb_shipCity','shipCity'],['wb_shipState','shipState'],
        ['wb_shipZip','shipZip'],['wb_shipStreet','shipStreet'],['wb_shipHouse','shipHouse'],
        ['wb_shipLength','shipLength'],['wb_shipWidth','shipWidth'],
        ['wb_shipHeight','shipHeight'],['wb_shipWeight','shipWeight'],
    ];
    pairs.forEach(([wbId, key]) => {
        const el = document.getElementById(wbId);
        if (el && el.value.trim()) row.dataset[key] = el.value.trim();
    });
    // також зберігаємо в HS/Desc
    const hs  = document.getElementById('shipHsCode');
    const dru = document.getElementById('shipDescRu');
    if (hs  && hs.value.trim())  row.dataset.shipHsCode  = hs.value.trim();
    if (dru && dru.value.trim()) row.dataset.shipDescRu  = dru.value.trim();
};
// --- Зберегти дані з панелі ---
window.wbSaveFromPanel = function() {
    window.wbSyncPanelToRow();
    const row = window._wbSelectedRow || window._shippingRow;
    if (!row) { showToast('Спочатку виберіть замовлення'); return; }
    const price    = document.getElementById('shippingPrice')?.value;
    const delivery = document.getElementById('shippingDelivery')?.value;
    if (price)    row.dataset.priceUsd    = price;
    if (delivery) row.dataset.deliveryUsd = delivery;
    if (typeof syncRowToDb === 'function') syncRowToDb(row);
    if (typeof updateShippingCell === 'function') updateShippingCell(row);
    showToast('✅ Збережено');
};
// --- Завантажити адреси відправника ---
window.wbLoadWarehouseSelect = async function() {
    if (window._wbShipperAddresses) { wbPopulateWarehouseSelect(window._wbShipperAddresses); return; }
    const sel = document.getElementById('shipWarehouseSelect');
    if (sel) sel.innerHTML = '<option>Завантаження...</option>';
    try {
        const data = await wbRequest('GET', '/api/v1/Shipping/GetUserAddresses');
        const list = Array.isArray(data) ? data : (data.Addresses || data.addresses || data.Items || []);
        window._wbShipperAddresses = list;
        wbPopulateWarehouseSelect(list);
    } catch(e) {
        if (sel) sel.innerHTML = '<option value="2017164">Irpin (ID: 2017164)</option>';
        const dbg = document.getElementById('shipWarehouseDebug');
        if (dbg) { dbg.style.display = 'block'; dbg.textContent = 'Помилка: ' + e.message; }
    }
};
function wbPopulateWarehouseSelect(list) {
    const sel = document.getElementById('shipWarehouseSelect');
    if (!sel) return;
    if (!list.length) {
        sel.innerHTML = '<option value="2017164">Irpin (ID: 2017164)</option>';
        return;
    }
    sel.innerHTML = list.map(a => {
        const id   = a.Id || a.id || '';
        const name = a.ContactName || a.Name || a.name || '';
        const city = a.City || a.city || '';
        return `<option value="${id}">${name} — ${city} (ID: ${id})</option>`;
    }).join('');
}
// --- Матеріали (для HS коду) ---
window.wbLoadMaterials = async function() {
    if (window._wbMaterials) { wbShowMaterialSearch(); return; }
    try {
        showToast('Завантаження матеріалів...');
        const data = await wbRequest('GET', '/api/v1/dictionary/GetMaterials?PageNr=1&PageSize=500');
        window._wbMaterials = data.Items || data.items || data || [];
        wbShowMaterialSearch();
    } catch(e) { showToast('Помилка завантаження: ' + e.message); }
};
function wbShowMaterialSearch() {
    const inp = document.getElementById('shipMaterialSearch');
    if (inp) { inp.style.display = ''; inp.focus(); }
    showToast(`✅ Завантажено ${(window._wbMaterials||[]).length} матеріалів`);
}
window.wbFilterMaterials = function(q) {
    const list = document.getElementById('shipMaterialList');
    if (!list || !window._wbMaterials) return;
    const filtered = window._wbMaterials.filter(m =>
        (m.NameEng||'').toLowerCase().includes(q.toLowerCase()) ||
        (m.NameRus||'').toLowerCase().includes(q.toLowerCase())
    ).slice(0, 30);
    if (!filtered.length) { list.style.display = 'none'; return; }
    list.style.display = 'block';
    list.innerHTML = filtered.map((m,i) =>
        `<div onclick="wbSelectMaterial(${i},'${(m.NameEng||'').replace(/'/g,"\\'")}','${(m.NameRus||'').replace(/'/g,"\\'")}',${JSON.stringify(m.HarmonizedCode||'')})"
              style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f3f4f6;"
              onmouseover="this.style.background='#f5f3ff'" onmouseout="this.style.background=''">
            <div style="font-weight:600;">${m.NameEng||''}</div>
            <div style="font-size:11px;color:#6b7280;">${m.NameRus||''}</div>
        </div>`
    ).join('');
};
window.wbSelectMaterial = function(idx, nameEng, nameRus, hsCode) {
    const list = document.getElementById('shipMaterialList');
    const sel  = document.getElementById('shipMaterialSelected');
    const inp  = document.getElementById('shipMaterialSearch');
    const dru  = document.getElementById('shipDescRu');
    const hs   = document.getElementById('shipHsCode');
    if (list) list.style.display = 'none';
    if (inp)  inp.value = nameEng;
    if (sel)  { sel.style.display = 'block'; sel.textContent = `✅ ${nameEng} / ${nameRus}`; }
    if (dru)  dru.value = nameRus;
    if (hs && hsCode) hs.value = hsCode;
};
// --- GetRates ---
window.wbGetRates = async function() {
    const btn    = document.getElementById('wbCalcBtn');
    const result = document.getElementById('wbRatesResult');
    const selDiv = document.getElementById('wbSelectedRate');
    const cbBtn  = document.getElementById('wbCreateBtn');
    if (btn)    { btn.disabled = true; btn.textContent = '⏳ Розрахунок...'; }
    if (result) { result.style.display = 'none'; result.innerHTML = ''; }
    if (selDiv) selDiv.style.display = 'none';
    if (cbBtn)  cbBtn.style.display = 'none';
    window._wbSelectedRateObj = null;
    const g   = id => (document.getElementById(id)?.value || '').trim();
    const row = window._wbSelectedRow || window._shippingRow;
    const name    = g('wb_shipName')    || row?.dataset.shipName    || '';
    const email   = g('wb_shipEmail')   || row?.dataset.shipEmail   || '';
    const phone   = g('wb_shipPhone')   || row?.dataset.shipPhone   || '';
    const country = g('wb_shipCountry') || row?.dataset.shipCountry || 'US';
    const city    = g('wb_shipCity')    || row?.dataset.shipCity    || '';
    const state   = g('wb_shipState')   || row?.dataset.shipState   || '';
    const zip     = g('wb_shipZip')     || row?.dataset.shipZip     || '';
    const street  = g('wb_shipStreet')  || row?.dataset.shipStreet  || '';
    const house   = g('wb_shipHouse')   || row?.dataset.shipHouse   || '';
    const L   = Math.max(1,   parseFloat(g('wb_shipLength') || row?.dataset.shipLength) || 10);
    const W   = Math.max(1,   parseFloat(g('wb_shipWidth')  || row?.dataset.shipWidth)  || 10);
    const H   = Math.max(1,   parseFloat(g('wb_shipHeight') || row?.dataset.shipHeight) || 10);
    const kg  = Math.max(0.1, parseFloat(g('wb_shipWeight') || row?.dataset.shipWeight) || 0.5);
    const priceUsd = Math.max(1, parseFloat(g('wb_shipPrice') || g('shippingPrice') || row?.dataset.priceUsd) || 1);
    const hsCode   = g('shipHsCode') || row?.dataset.shipHsCode || '4420190000';
    const descRu   = g('shipDescRu') || row?.dataset.shipDescRu || 'Дерев\'яний виріб';
    const descEn   = wbSafeDesc(g('wb_shipDescEn') || descRu || 'Wooden article').slice(0, 50);
    // Валідація
    if (!city || !zip || !street) {
        if (result) { result.style.display = 'flex'; result.innerHTML = `<div style="color:#ef4444;padding:10px;background:#fef2f2;border-radius:8px;">⚠️ Заповніть адресу отримувача (крок 1): місто, індекс, вулиця</div>`; }
        if (btn) { btn.disabled = false; btn.textContent = '➜ Розрахувати тарифи'; }
        return;
    }
    // Відправник
    const addrList = window._wbShipperAddresses || [];
    const selEl    = document.getElementById('shipWarehouseSelect');
    const selId    = parseInt(selEl?.value) || 2017164;
    const addr     = addrList.find(a => (a.Id||a.id) == selId) || {};
    const body = {
        Shipper: {
            Contact: {
                PersonName:   addr.ContactName || addr.Name || 'Macogon Oleksiy',
                EmailAddress: addr.Email       || 'info@babak.com',
                PhoneNumber:  addr.Phone       || '+380671234567'
            },
            Address: {
                CountryCode: addr.CountryCode || 'UA',
                City:        addr.City        || 'Irpin',
                Street:      addr.Street      || 'Sadova',
                HouseNumber: addr.HouseNumber || '92',
                StreetLines: [(addr.Street || 'Sadova') + ' ' + (addr.HouseNumber || '92')],
                PostalCode:  addr.ZipCode     || '08205'
            },
            WarehouseReferenceId: selId
        },
        Recipient: {
            Contact: { PersonName: name, EmailAddress: email, PhoneNumber: phone },
            Address: {
                CountryCode:         country,
                City:                city,
                StateOrProvinceCode: state,
                PostalCode:          zip,
                Street:              street,
                HouseNumber:         house,
                StreetLines:         [street + (house ? ' ' + house : '')]
            }
        },
        Package: {
            Dimensions: { Length: L, Width: W, Height: H },
            Weight: kg
        },
        PackageItems: [{
            Description:          descEn,
            DescriptionRu:        descRu,
            HarmonizedCode:       hsCode,
            HsCode:               hsCode,
            Quantity:             1,
            UnitPrice:            { Amount: priceUsd, CurrencyCode: 'USD' },
            CountryOfManufacture: 'UA'
        }]
    };
    try {
        const data = await wbRequest('POST', '/api/v1/Shipping/GetRates', body);
        // WB API повертає масив напряму
        const rates = Array.isArray(data) ? data : (data.Rates || data.Items || []);
        const validRates = rates.filter(r => r.ShippingCost?.Amount && !r.ErrorMessage);
        if (!validRates.length) {
            const errRates = rates.filter(r => r.ErrorMessage);
            const msg = errRates.length
                ? errRates.map(r => `${r.ShippingType}: ${r.ErrorMessage}`).join('<br>')
                : 'Тарифи не знайдені. Відповідь: ' + JSON.stringify(data).slice(0, 300);
            if (result) { result.style.display = 'flex'; result.innerHTML = `<div style="color:#ef4444;padding:10px;background:#fef2f2;border-radius:8px;">${msg}</div>`; }
        } else {
            window._wbRatesList = validRates;
            if (result) {
                result.style.display = 'flex';
                result.innerHTML = validRates.map((r, i) => {
                    const carrier = r.ShippingType || 'Carrier';
                    const service = r.ShippingServiceType ? `<span style="font-size:10px;color:#6b7280;margin-left:4px;">${r.ShippingServiceType}</span>` : '';
                    const price   = parseFloat(r.ShippingCost?.Amount) || 0;
                    const minD    = r.MinDeliveryDays || '?';
                    const maxD    = r.MaxDeliveryDays ? `–${r.MaxDeliveryDays}` : '';
                    return `<div onclick="wbSelectRate(${i})" class="wb-rate-card">
                        <div>
                            <div style="font-weight:700;font-size:13px;">${carrier}${service}</div>
                            <div style="font-size:11px;color:#6b7280;">${minD}${maxD} днів</div>
                        </div>
                        <div style="font-weight:800;font-size:15px;color:#2c9e6e;">$${price.toFixed(2)}</div>
                    </div>`;
                }).join('');
            }
        }
    } catch(e) {
        if (result) { result.style.display = 'flex'; result.innerHTML = `<div style="color:#ef4444;padding:10px;background:#fef2f2;border-radius:8px;">❌ ${e.message}</div>`; }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '➜ Розрахувати тарифи'; }
    }
};
window.wbSelectRate = function(idx) {
    const rate = (window._wbRatesList || [])[idx];
    if (!rate) return;
    window._wbSelectedRateObj = rate;
    document.querySelectorAll('.wb-rate-card').forEach((el, i) => el.classList.toggle('sel', i === idx));
    const infoEl = document.getElementById('wbSelectedRateInfo');
    const selDiv = document.getElementById('wbSelectedRate');
    const cbBtn  = document.getElementById('wbCreateBtn');
    const price  = parseFloat(rate.ShippingCost?.Amount) || 0;
    if (infoEl) infoEl.textContent = `${rate.ShippingType} ${rate.ShippingServiceType || ''} — $${price.toFixed(2)}`;
    if (selDiv) selDiv.style.display = 'block';
    if (cbBtn)  { cbBtn.style.display = 'inline-block'; cbBtn.textContent = 'Продовжити →'; cbBtn.onclick = function(e){ e.stopPropagation(); if(typeof wbGoStep==='function'){wbGoStep(3); wbFillSt3();} }; }
    const delEl = document.getElementById('shippingDelivery');
    if (delEl) delEl.value = price.toFixed(2);
    const rr = document.getElementById('wbRatesResult');
    if (rr) rr.style.display = 'none';
};
// --- CreateShipment ---
window.wbCreateShipment = async function() {
    if (!window._wbSelectedRateObj) { alert('Спочатку розрахуйте тарифи і виберіть один.'); return; }
    const rate = window._wbSelectedRateObj;
    const g    = id => (document.getElementById(id)?.value || '').trim();
    const row  = window._wbSelectedRow || window._shippingRow;
    const addrList = window._wbShipperAddresses || [];
    const selEl    = document.getElementById('shipWarehouseSelect');
    const selId    = parseInt(selEl?.value) || 2017164;
    const addr     = addrList.find(a => (a.Id||a.id) == selId) || {};
    const name    = g('wb_shipName')    || row?.dataset.shipName    || '';
    const email   = g('wb_shipEmail')   || row?.dataset.shipEmail   || '';
    const phone   = g('wb_shipPhone')   || row?.dataset.shipPhone   || '';
    const country = g('wb_shipCountry') || row?.dataset.shipCountry || 'US';
    const city    = g('wb_shipCity')    || row?.dataset.shipCity    || '';
    const state   = g('wb_shipState')   || row?.dataset.shipState   || '';
    const zip     = g('wb_shipZip')     || row?.dataset.shipZip     || '';
    const street  = g('wb_shipStreet')  || row?.dataset.shipStreet  || '';
    const house   = g('wb_shipHouse')   || row?.dataset.shipHouse   || '';
    const L   = Math.max(1,   parseFloat(g('wb_shipLength') || row?.dataset.shipLength) || 10);
    const W   = Math.max(1,   parseFloat(g('wb_shipWidth')  || row?.dataset.shipWidth)  || 10);
    const H   = Math.max(1,   parseFloat(g('wb_shipHeight') || row?.dataset.shipHeight) || 10);
    const kg  = Math.max(0.1, parseFloat(g('wb_shipWeight') || row?.dataset.shipWeight) || 0.5);
    const hsCode   = g('shipHsCode')  || row?.dataset.shipHsCode || '4420190000';
    const descRu   = g('shipDescRu')  || row?.dataset.shipDescRu || 'Дерев\'яний виріб';
    const descEn   = wbSafeDesc(g('wb_shipDescEn') || descRu || 'Wooden article').slice(0, 50);
    const priceUsd = Math.max(1, parseFloat(g('wb_shipPrice') || g('shippingPrice') || row?.dataset.priceUsd) || 1);
    const qty      = parseInt(g('wb_shipQty')) || 1;
    // Перевізник береться напряму з ShippingType відповіді WB API
    const carrierKey = rate.ShippingType || 'UPS';
    let Options = { IncludeDeliveryCostInInvoice: false, UseInsurance: false, UseDeliveryConfirmation: false };
    if (carrierKey === 'UPS' || carrierKey === 'FedEx') {
        Options.ShippingServiceType = rate.ShippingServiceType || 'UpsExpressPlus';
    }
    if (carrierKey === 'ConsolidationPlus') {
        Options.CarrierType = rate.CarrierType || 'FedEx';
        Options.ParcelType  = rate.ParcelType  || 'UpsSurePost';
    }
    if (carrierKey === 'Optimum') {
        Options.ParcelType = rate.ParcelType || 'UpsSurePost';
    }
    const sC = { PersonName: addr.ContactName||addr.Name||'Macogon Oleksiy', EmailAddress: addr.Email||'info@babak.com', PhoneNumber: addr.Phone||'+380671234567' };
    const sA = { CountryCode: addr.CountryCode||'UA', City: addr.City||'Irpin', Street: addr.Street||'Sadova', HouseNumber: addr.HouseNumber||'92', StreetLines: [(addr.Street||'Sadova')+' '+(addr.HouseNumber||'92')], PostalCode: addr.ZipCode||'08205' };
    const rC = { PersonName: name, EmailAddress: email, PhoneNumber: phone };
    const rA = { CountryCode: country, City: city, PostalCode: zip, Street: street, HouseNumber: house, StreetLines: [street+(house?' '+house:'')] };
    if (state) rA.StateOrProvinceCode = state;
    const pkg = { Dimensions: { Length: L, Width: W, Height: H }, Weight: kg };
    const pkgItems = [{ Description: descEn, DescriptionRu: descRu, HarmonizedCode: hsCode, HsCode: hsCode, Quantity: qty, UnitPrice: { Amount: priceUsd, CurrencyCode: 'USD' }, CountryOfManufacture: 'UA' }];
    let body;
    if (carrierKey === 'NovaPost' || carrierKey === 'NovaGlobal') {
        const npBranch = (document.getElementById('wb_npSenderBranch')?.value||'').trim();
        if (!npBranch) {
            alert('⚠️ Для Нової Пошти виберіть відділення відправника (Крок 4)');
            const cb2 = document.getElementById('wb4CreateBtn')||document.getElementById('wbCreateBtn');
            if (cb2) { cb2.disabled=false; cb2.textContent='📦 Створити накладну WB'; }
            return;
        }
        body = { Shipper: { WarehouseReferenceId: npBranch, Contact: sC, Address: sA }, Recipient: { Contact: rC, Address: rA }, Package: pkg, PackageItems: pkgItems, Options };
    } else {
        body = { Shipper: { Contact: sC, Address: sA, WarehouseReferenceId: selId }, Recipient: { Contact: rC, Address: rA }, Package: pkg, PackageItems: pkgItems, Options };
    }
    const cb = document.getElementById('wb4CreateBtn') || document.getElementById('wbCreateBtn');
    if (cb) { cb.disabled = true; cb.textContent = '⏳ Створення...'; }
    try {
        const data = await wbRequest('POST', `/api/v1/Shipping/CreateShipment/${carrierKey}`, body);
        const shipId   = data.ShipmentId  || data.shipmentId  || data.Id   || data.id;
        const trackNum = data.TrackingNumber || data.trackingNumber || '';
        const shipCost = data.ShippingCost?.Amount || '';
        const docsUrl  = data.DocumentsUrl || '';
        if (shipId) {
            if (row) {
                row.dataset.wbShipmentId = shipId;
                if (trackNum) row.dataset.tracking = trackNum;
                if (typeof syncRowToDb === 'function') syncRowToDb(row);
                const statusCell = row.querySelector('td[data-type="status"]');
                if (statusCell) {
                    statusCell.dataset.val = 'Відправка';
                    statusCell.innerHTML   = getStatusHtml('Відправка');
                }
                const trackCell = row.querySelector('td[data-type="tracking"]');
                if (trackCell && trackNum) { trackCell.dataset.val = trackNum; trackCell.textContent = trackNum; }
            }
            showToast(`✅ Накладна створена! ${trackNum ? 'Трекінг: ' + trackNum : 'ID: ' + shipId}`);
            const summary = document.getElementById('wbSummary');
            if (summary) {
                summary.innerHTML += `<div style="margin-top:12px;padding:12px;background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:8px;">
                    <div>✅ <b>Накладна створена!</b></div>
                    ${trackNum ? `<div>📦 Трекінг: <b>${trackNum}</b></div>` : `<div>ID: ${shipId}</div>`}
                    ${shipCost ? `<div>💰 Вартість: $${shipCost}</div>` : ''}
                    ${docsUrl  ? `<div><a href="${docsUrl}" target="_blank" style="color:#16a34a;font-weight:600;">📄 Завантажити документи</a></div>` : ''}
                </div>`;
            }
        } else {
            alert('Відповідь WB:\n' + JSON.stringify(data, null, 2).slice(0, 600));
        }
    } catch(e) {
        alert('❌ Помилка:\n' + e.message);
    } finally {
        if (cb) { cb.disabled = false; cb.textContent = '📦 Створити накладну WB'; }
    }
};
// === Збереження / завантаження даних відправника ===
window.wbfSaveShipper = async function() {
    const g = id => (document.getElementById(id)?.value || '').trim();
    const status = document.getElementById('wbf_shipSaveStatus');
    const shipper = {
        name: g('wbf_shipName'), email: g('wbf_shipEmail'),
        phone: g('wbf_shipPhone'), ioss: g('wbf_shipIoss'),
        country: g('wbf_shipCountry'), city: g('wbf_shipCity'),
        street: g('wbf_shipStreet'), house: g('wbf_shipHouse'),
        zip: g('wbf_shipZip'), state: g('wbf_shipState'),
    };
    // Зберігаємо локально одразу
    try { localStorage.setItem('tabix_shipper_cache', JSON.stringify(shipper)); } catch(e) {}
    // Зберігаємо в Firebase
    try {
        await db.collection('babak_crm').doc('shipper_settings').set(shipper);
        if (status) { status.textContent = '✓ Збережено'; status.style.color = '#16a34a'; }
        setTimeout(() => { if (status) status.textContent = ''; }, 3000);
    } catch(e) {
        if (status) { status.textContent = 'Помилка'; status.style.color = '#ef4444'; }
    }
};
async function wbfLoadShipper() {
    const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
    // Спочатку — локальний кеш (миттєво)
    try {
        const cached = localStorage.getItem('tabix_shipper_cache');
        if (cached) {
            const s = JSON.parse(cached);
            set('wbf_shipName', s.name); set('wbf_shipEmail', s.email);
            set('wbf_shipPhone', s.phone); set('wbf_shipIoss', s.ioss);
            set('wbf_shipCountry', s.country); set('wbf_shipCity', s.city);
            set('wbf_shipStreet', s.street); set('wbf_shipHouse', s.house);
            set('wbf_shipZip', s.zip); set('wbf_shipState', s.state);
        }
    } catch(e) {}
    // Потім Firebase (актуальні дані)
    try {
        const doc = await db.collection('babak_crm').doc('shipper_settings').get();
        if (!doc.exists) return;
        const s = doc.data();
        set('wbf_shipName', s.name); set('wbf_shipEmail', s.email);
        set('wbf_shipPhone', s.phone); set('wbf_shipIoss', s.ioss);
        set('wbf_shipCountry', s.country); set('wbf_shipCity', s.city);
        set('wbf_shipStreet', s.street); set('wbf_shipHouse', s.house);
        set('wbf_shipZip', s.zip); set('wbf_shipState', s.state);
        // Оновлюємо кеш
        try { localStorage.setItem('tabix_shipper_cache', JSON.stringify(s)); } catch(e) {}
    } catch(e) { console.warn('wbfLoadShipper:', e.message); }
}
// Завантажуємо при відкритті вкладки та при ініціалізації
const _origSwitchView = window.switchView;
window.switchView = function(viewId) {
    _origSwitchView(viewId);
    if (viewId === 'shippingView') wbfLoadShipper();
};
// ============================================================
// ВКЛАДКА ВІДПРАВКА — всі функції форми
// ============================================================
window.wbfToggleSection = function(titleEl) {
    const body    = titleEl.nextElementSibling;
    const chevron = titleEl.querySelector('.wb-chevron');
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
};
let _wbfCarrier = 'UPS', _wbfRatesList = [], _wbfSelectedRate = null;
window.wbfShowResult = function(html) {
    const r = document.getElementById('wbf_result');
    if (!r) return;
    r.style.display = 'block';
    r.innerHTML = html;
};
window.wbfGetBody = function() {
    const g  = id => (document.getElementById(id)?.value || '').trim();
    const gn = id => parseFloat(document.getElementById(id)?.value) || 0;
    const weight = gn('wbf_weight') || 0.1;
    const sC = { PersonName: g('wbf_shipName'), EmailAddress: g('wbf_shipEmail'), PhoneNumber: g('wbf_shipPhone') };
    const sA = { CountryCode: (g('wbf_shipCountry')||'UA').toUpperCase(), City: g('wbf_shipCity'), StreetLines: [g('wbf_shipStreet')], HouseNumber: g('wbf_shipHouse'), PostalCode: g('wbf_shipZip'), StateOrProvinceCode: g('wbf_shipState') };
    const rC = { PersonName: g('wbf_recipientName'), EmailAddress: g('wbf_recipientEmail'), PhoneNumber: g('wbf_recipientPhone') };
    const rA = { CountryCode: (g('wbf_recipientCountry')||'US').toUpperCase(), City: g('wbf_recipientCity'), StreetLines: [g('wbf_recipientStreet')], HouseNumber: g('wbf_recipientHouse'), PostalCode: g('wbf_recipientZip'), StateOrProvinceCode: g('wbf_recipientState') };
    const pkg = { Dimensions: { Length: gn('wbf_length')||10, Width: gn('wbf_width')||10, Height: gn('wbf_height')||5 }, Weight: weight };
    const pkgItems = [{ Description: g('wbf_descEn')||'wooden hand made decor', DescriptionRu: g('wbf_descRu')||"Дерев'яні вироби з дерева", HarmonizedCode: g('wbf_hsCode')||'4420190000', MaterialId: parseInt(g('wbf_materialId'))||78, Quantity: parseInt(g('wbf_qty'))||1, Weight: weight, UnitPrice: { Amount: gn('wbf_price')||30, CurrencyCode: 'USD' }, CountryOfManufacture: 'UA' }];
    const Options = { ShippingServiceType: window._wbfSelectedServiceType||'', IncludeDeliveryCostInInvoice: g('wbf_inclDelivery')==='true', UseInsurance: g('wbf_useInsurance')==='true', UseDeliveryConfirmation: g('wbf_useConfirm')==='true', CarrierType: g('wbf_carrierType')||undefined, ParcelType: g('wbf_parcelType')||undefined, PassportFiles: [], IsLegal: g('wbf_npgIsLegal')==='true' };
    const iossNum = g('wbf_shipIoss'); if (iossNum) Options.IOSSNumber = iossNum;
    const npBranch = g('wbf_npBranch');
    const carrier = _wbfCarrier;
    let body;
    if (['NovaPost','NovaGlobal'].includes(carrier)) {
        body = { Shipper: { WarehouseReferenceId: npBranch, Contact: sC, Address: sA }, Recipient: { Contact: rC, Address: rA }, Package: pkg, PackageItems: pkgItems, Options };
    } else if (carrier === 'NPG') {
        body = { Shipper: { Contact: sC, Address: sA, WarehouseReferenceId: npBranch||undefined }, Recipient: { Contact: rC, Address: rA, IsLegal: Options.IsLegal }, Package: pkg, PackageItems: pkgItems, Options };
    } else {
        body = { Shipper: { Contact: sC, Address: sA }, Recipient: { Contact: rC, Address: rA }, Package: pkg, PackageItems: pkgItems, Options };
    }
    return body;
};
function wbfSetErr(id, show) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.classList.toggle('wb-err', show);
    el.classList.toggle('wb-ok', !show && el.value.trim() !== '');
    return show;
}
function wbfValidate() {
    const g = id => (document.getElementById(id)?.value || '').trim();
    let err = false;
    err = wbfSetErr('wbf_recipientName',    !g('wbf_recipientName')) || err;
    err = wbfSetErr('wbf_recipientPhone',   !/^\+?[\d\s\-()]{7,20}$/.test(g('wbf_recipientPhone'))) || err;
    err = wbfSetErr('wbf_recipientCountry', !/^[A-Z]{2}$/i.test(g('wbf_recipientCountry'))) || err;
    err = wbfSetErr('wbf_recipientCity',    !g('wbf_recipientCity') || /[а-яёА-ЯЁіІїЇєЄ]/.test(g('wbf_recipientCity'))) || err;
    err = wbfSetErr('wbf_recipientStreet',  !g('wbf_recipientStreet') || /[а-яёА-ЯЁіІїЇєЄ]/.test(g('wbf_recipientStreet'))) || err;
    err = wbfSetErr('wbf_recipientHouse',   !g('wbf_recipientHouse')) || err;
    err = wbfSetErr('wbf_recipientZip',     !g('wbf_recipientZip')) || err;
    const country = g('wbf_recipientCountry').toUpperCase();
    if (['US','CA'].includes(country)) err = wbfSetErr('wbf_recipientState', !g('wbf_recipientState') || /[а-яёА-ЯЁіІїЇєЄ]/.test(g('wbf_recipientState'))) || err;
    err = wbfSetErr('wbf_length', parseFloat(g('wbf_length')) < 1) || err;
    err = wbfSetErr('wbf_width',  parseFloat(g('wbf_width'))  < 1) || err;
    err = wbfSetErr('wbf_height', parseFloat(g('wbf_height')) < 1) || err;
    err = wbfSetErr('wbf_weight', parseFloat(g('wbf_weight')) < 0.1) || err;
    err = wbfSetErr('wbf_price',  parseFloat(g('wbf_price'))  <= 0) || err;
    err = wbfSetErr('wbf_descEn', g('wbf_descEn').length < 20) || err;
    if (err) {
        ['wbf_recipientName','wbf_recipientCity','wbf_length','wbf_descEn'].forEach(id => {
            const el = document.getElementById(id);
            if (el?.classList.contains('wb-err')) {
                const body = el.closest('.wb-section-body');
                if (body && body.style.display === 'none') { const title = body.previousElementSibling; if (title) wbfToggleSection(title); }
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        });
    }
    return !err;
}
window.wbfGetRates = async function() {
    const btn = document.getElementById('wbf_btnRates');
    if (btn) { btn.disabled = true; btn.textContent = 'Розраховуємо...'; }
    if (!wbfValidate()) {
        if (btn) { btn.disabled = false; btn.textContent = 'Розрахувати тарифи'; }
        wbfShowResult('<div style="padding:14px;color:#ef4444;font-size:13px;background:#fff5f5;border-radius:12px;border:1px solid #fecaca;">Заповніть всі обов\'язкові поля</div>');
        return;
    }
    wbfShowResult('<div style="padding:14px;color:#9ca3af;font-size:13px;background:#f9f9fb;border-radius:12px;">Завантажуємо тарифи...</div>');
    _wbfRatesList = []; _wbfSelectedRate = null;
    try {
        const body = wbfGetBody();
        const data = await wbRequest('POST', '/api/v1/Shipping/GetRates', { Shipper: body.Shipper, Recipient: body.Recipient, Package: body.Package, PackageItems: body.PackageItems });
        const rates = Array.isArray(data) ? data.filter(r => r.ShippingCost && !r.ErrorMessage) : [];
        if (!rates.length) { wbfShowResult('<div style="padding:14px;color:#ef4444;font-size:13px;background:#fef2f2;border-radius:12px;">Тарифи не знайдено. Перевірте дані.</div>'); return; }
        _wbfRatesList = rates;
        const cards = rates.map((r, i) => {
            const price = parseFloat(r.ShippingCost?.Amount||0).toFixed(2);
            const minD = r.MinDeliveryDays||'?', maxD = r.MaxDeliveryDays ? `–${r.MaxDeliveryDays}` : '';
            const svc  = r.ShippingServiceType||'';
            const isNP = ['NovaPost','NovaGlobal','NPG'].includes(r.ShippingType);
            return `<div onclick="wbfSelectRate(${i},this)" id="wbf_rateCard_${i}" class="wb-rate-card" data-carrier="${r.ShippingType}" data-is-np="${isNP}">
                <div><div class="rc-carrier">${r.ShippingType}</div>${svc?`<div class="rc-service">${svc}</div>`:''}</div>
                <div class="rc-price">$${price}</div>
                <div class="rc-days">${minD}${maxD} днів</div>
                <button class="rc-create-btn" onclick="event.stopPropagation();wbfOnCreateClick(${isNP})">Створити накладну →</button>
            </div>`;
        }).join('');
        wbfShowResult(`<div style="padding:16px;background:white;border:1px solid #eceef2;border-radius:12px;">
            <div style="font-size:10px;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:12px;">Оберіть варіант доставки</div>
            <div class="wb-rates-grid">${cards}</div>
        </div>`);
    } catch(e) {
        wbfShowResult(`<div style="padding:14px;color:#ef4444;font-size:13px;background:#fef2f2;border-radius:12px;">Помилка: ${e.message}</div>`);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Розрахувати тарифи'; }
    }
};
window.wbfSelectRate = function(idx, el) {
    document.querySelectorAll('[id^="wbf_rateCard_"]').forEach(c => c.classList.remove('sel'));
    el.classList.add('sel');
    const r = _wbfRatesList[idx];
    _wbfSelectedRate = r; _wbfCarrier = r.ShippingType;
    window._wbfSelectedServiceType = r.ShippingServiceType||'';
    const isNP = ['NovaPost','NovaGlobal','NPG'].includes(r.ShippingType);
    if (isNP) setTimeout(() => wbNpModalOpen(), 150);
};
window.wbfOnCreateClick = function(isNP) {
    if (isNP && !document.getElementById('wbf_npBranch')?.value) { wbNpModalOpen(); return; }
    wbfCreateShipment();
};
window.wbfCreateShipment = async function() {
    const activeBtns = document.querySelectorAll('.rc-create-btn');
    activeBtns.forEach(b => { b.disabled = true; b.textContent = 'Створюємо...'; });
    try {
        const body = wbfGetBody();
        if (window._wbfSelectedServiceType && body.Options) body.Options.ShippingServiceType = window._wbfSelectedServiceType;
        const endpointMap = { UPS:'UPS', FedEx:'FedEx', DPD:'DPD', NovaPost:'NovaPost', NovaPoshtaGlobal:'NovaPost', NovaGlobal:'NovaPost', NPG:'NPG', ConsolidationPlus:'ConsolidationPlus', ConsolidationOptimum:'Optimum', Optimum:'Optimum' };
        const endpoint = endpointMap[_wbfCarrier] || _wbfCarrier;
        const itemLink = (document.getElementById('wbf_itemLink')?.value||'').trim();
        if (itemLink) {
            try {
                const g = id => (document.getElementById(id)?.value||'').trim();
                await wbRequest('POST', '/api/v1/UserSales/Import', [{ ItemNumber: Date.now().toString(), custEmail: g('wbf_recipientEmail'), custName: g('wbf_recipientName'), amtNet: parseFloat(g('wbf_price'))||0, Description: g('wbf_descEn')||'wooden hand made decor', ItemLink: itemLink, AddressLine1: (g('wbf_recipientStreet')+' '+g('wbf_recipientHouse')).trim(), AddressZip: g('wbf_recipientZip'), AddressCity: g('wbf_recipientCity'), AddressState: g('wbf_recipientState'), AddressPhone: g('wbf_recipientPhone'), AddressCountryCode: (g('wbf_recipientCountry')||'US').toUpperCase() }]);
            } catch(e) { console.warn('UserSales:', e.message); }
        }
        const data = await wbRequest('POST', `/api/v1/Shipping/CreateShipment/${endpoint}`, body);
        const trackNum = data.TrackingNumber||data.trackingNumber||'';
        const cost     = data.ShippingCost?.Amount||'';
        const shipId   = data.ShipmentId||'';
        const docsUrl  = data.DocumentsUrl||'';
        const pdfBtn = shipId ? `<button onclick="wbfDownloadPDF('${shipId}',this)" title="Завантажити PDF" style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:56px;height:56px;background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;cursor:pointer;gap:2px;padding:0;" onmouseover="this.style.borderColor='#111827'" onmouseout="this.style.borderColor='#e5e7eb'"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span style="font-size:9px;font-weight:700;color:#ef4444;">PDF</span></button>` : (docsUrl?`<a href="${docsUrl}" target="_blank" style="display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:56px;height:56px;background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;text-decoration:none;gap:2px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span style="font-size:9px;font-weight:700;color:#ef4444;">PDF</span></a>`:'');
        wbfShowResult(`<div style="padding:20px;background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:12px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
            <div><div style="font-size:14px;font-weight:700;color:#16a34a;margin-bottom:8px;">Накладну створено!</div>
            ${trackNum?`<div style="font-size:13px;color:#374151;margin-bottom:4px;">Трекінг: <b>${trackNum}</b></div>`:''}
            ${cost?`<div style="font-size:13px;color:#6b7280;">Вартість: <b style="color:#374151;">$${cost}</b></div>`:''}</div>
            <div style="flex-shrink:0;">${pdfBtn}</div></div>`);
    } catch(e) {
        wbfShowResult(`<div style="padding:14px;color:#ef4444;font-size:13px;background:#fef2f2;border-radius:12px;">Помилка: ${e.message}</div>`);
    } finally {
        document.querySelectorAll('.rc-create-btn').forEach(b => { b.disabled=false; b.textContent='Створити накладну →'; });
    }
};
window.wbfDownloadPDF = async function(shipmentId, btn) {
    if (btn) { btn.style.opacity='0.5'; btn.style.pointerEvents='none'; }
    try {
        const res = await fetch(WB_PROXY, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ method:'GET', path:`/api/v1/ShipmentDocument/GetDocument?ShipmentId=${shipmentId}&DocumentType=Label&PaperSize=A4`, binary:true }) });
        if (!res.ok) throw new Error('proxy error');
        const blob = await res.blob();
        if (blob.size < 100) throw new Error('empty');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href=url; a.download=`nakладна_${shipmentId}.pdf`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch(e) {
        window.open(`https://system.westernbid.com/Ups/ShipmentDocs?shipmentId=${shipmentId}`, '_blank');
    } finally {
        if (btn) { btn.style.opacity='1'; btn.style.pointerEvents=''; }
    }
};
// Nova Post модалка
let _wbNpBranches = [], _wbNpSelected = null;
window.wbNpModalOpen = async function() {
    const modal = document.getElementById('wbNpModal');
    if (!modal) return;
    const list = document.getElementById('wbNpList');
    const sub  = document.getElementById('wbNpModalSub');
    const confirmBtn = document.getElementById('wbNpConfirmBtn');
    const city = document.getElementById('wbf_npCity')?.value || 'Рівне';
    modal.style.display = 'flex';
    if (list) list.innerHTML = '<div style="padding:20px;text-align:center;color:#9ca3af;font-size:13px;">Завантаження...</div>';
    if (sub) sub.textContent = `${city} — завантаження...`;
    if (confirmBtn) confirmBtn.disabled = true;
    _wbNpSelected = null;
    const fi = document.getElementById('wbNpFilterInput'); if (fi) fi.value = '';
    try {
        const data = await wbRequest('GET', `/api/v1/dictionary/GetNovaPostWarehouses?Filter=${encodeURIComponent(city)}&CountryCode=UA&PageNr=1&PageSize=200`);
        _wbNpBranches = (data.Data||[]).map(b => {
            const ref = b.WarehouseReferenceId||b.WarehouseRef||b.Ref||b.Id||'';
            const num = b.Number||b.WarehouseIndex||b.BranchNumber||'';
            let addr = '';
            if (b.Address) { const a=b.Address; addr=[a.City||a.CityDescription||'', a.Street||a.StreetDescription||'', a.HouseNumber||''].filter(Boolean).join(', '); }
            if (!addr) addr = b.ShortAddress||b.FullAddress||b.Description||b.Name||'';
            return { ref, label: num && addr ? `№${num} — ${addr}` : (addr||num||ref) };
        });
        if (sub) sub.textContent = `${city} — ${_wbNpBranches.length} відділень`;
        wbNpRenderList(_wbNpBranches);
        const def = _wbNpBranches.find(b => b.label.includes('81/14'));
        if (def) {
            _wbNpSelected = def;
            if (confirmBtn) confirmBtn.disabled = false;
            setTimeout(() => { const el = document.querySelector(`[data-ref="${def.ref}"]`); if (el) { el.classList.add('sel'); el.scrollIntoView({ block:'center', behavior:'smooth' }); } }, 100);
        }
    } catch(e) {
        if (list) list.innerHTML = `<div style="padding:20px;text-align:center;color:#ef4444;font-size:13px;">Помилка: ${e.message}</div>`;
    }
};
function wbNpRenderList(branches) {
    const list = document.getElementById('wbNpList');
    if (!list) return;
    if (!branches.length) { list.innerHTML = '<div style="padding:20px;text-align:center;color:#9ca3af;font-size:13px;">Нічого не знайдено</div>'; return; }
    list.innerHTML = branches.map(b => {
        const sl = b.label.replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        return `<div class="wb-np-item${_wbNpSelected?.ref===b.ref?' sel':''}" data-ref="${b.ref}" data-label="${sl}" onclick="wbNpSelectItem(this)">${b.label}</div>`;
    }).join('');
}
window.wbNpFilter = function(q) {
    if (!q) { wbNpRenderList(_wbNpBranches); return; }
    wbNpRenderList(_wbNpBranches.filter(b => b.label.toLowerCase().includes(q.toLowerCase())));
};
window.wbNpSelectItem = function(el) {
    document.querySelectorAll('.wb-np-item').forEach(i => i.classList.remove('sel'));
    el.classList.add('sel');
    _wbNpSelected = { ref: el.dataset.ref, label: el.dataset.label };
    const btn = document.getElementById('wbNpConfirmBtn');
    if (btn) btn.disabled = false;
};
window.wbNpConfirm = function() {
    if (!_wbNpSelected) return;
    document.getElementById('wbf_npBranch').value = _wbNpSelected.ref;
    const rateCard = document.querySelector('[data-is-np="true"].sel');
    if (rateCard) {
        let npLabel = rateCard.querySelector('.rc-np-label');
        if (!npLabel) {
            npLabel = document.createElement('div');
            npLabel.className = 'rc-np-label';
            npLabel.style.cssText = 'font-size:10px;color:#16a34a;margin-top:6px;padding:5px 8px;background:rgba(22,163,74,0.08);border-radius:6px;word-break:break-word;line-height:1.4;';
            const cb = rateCard.querySelector('.rc-create-btn');
            if (cb) cb.before(npLabel); else rateCard.appendChild(npLabel);
        }
        npLabel.textContent = '📍 ' + _wbNpSelected.label.replace(/Відділення /g,'').slice(0,60);
    }
    wbNpModalClose();
};
window.wbNpModalClose = function() {
    const m = document.getElementById('wbNpModal');
    if (m) m.style.display = 'none';
};
document.addEventListener('DOMContentLoaded', () => {
    ['wbf_recipientName','wbf_recipientPhone','wbf_recipientCountry','wbf_recipientCity',
     'wbf_recipientStreet','wbf_recipientHouse','wbf_recipientZip','wbf_length','wbf_width',
     'wbf_height','wbf_weight','wbf_price','wbf_descEn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('blur', () => wbfSetErr(id, false));
    });
});