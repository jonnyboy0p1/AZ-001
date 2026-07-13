// ==UserScript==
// @name         FCResearch+
// @version      1.3.3
// @description  FCResearch Enhanced — Hazmat, Prep, Box Recommendation, Floor Info, Diver, Quick Print, DataMatrix Generator & more
// @author       josexmor
// @updateURL     https://tamarin.aces.amazon.dev/scripts/fcresearch/install.user.js
// @downloadURL   https://tamarin.aces.amazon.dev/scripts/fcresearch/install.user.js
// @match        https://fcresearch-na.aka.amazon.com/*
// @match        https://qi-fcresearch-na.corp.amazon.com/*
// @match        https://qifcr.na.aftx.amazonoperations.app/*
// @match        http://fc-andons-na.corp.amazon.com/*
// @match        https://diver.qts.amazon.dev/*
// @icon         https://www.amazon.com/favicon.ico
// @grant        GM_addStyle
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://code.jquery.com/jquery-3.6.0.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery-cookie/1.4.1/jquery.cookie.min.js
// @require      https://cdn.jsdelivr.net/npm/jsbarcode@3.11.0/dist/JsBarcode.all.min.js
// @connect      pandash.amazon.com
// @connect      prepmanager-dub.amazon.com
// @connect      box-web-dub.amazon.com
// @connect      roboscout.amazon.com
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";
    if (window.FCRPlusInitialized) { console.log("FCResearch+ already running"); return; }
    window.FCRPlusInitialized = true;
    window.FCRPlusVersion = "1.3.3";

    // ========================================
    // CONFIG
    // ========================================
    const CONFIG = {
        warehouses: { list: JSON.parse(GM_getValue("userFCList", '["RMU1","ZAZ1","CDG7","WRO5","DTM2","HAJ1"]')), default: GM_getValue("userDefaultFC", "RMU1") },
        endpoints: {
            base: window.location.origin,
            printHost: "http://localhost:5965/printer",
            roboscout: "https://roboscout.amazon.com",
            badgePhotos: "https://badgephotos.amazon.com",
            diver: "https://diver.qts.amazon.dev/tools/transshipment/dashboards/transfer_details",
            pandash: "https://pandash.amazon.com/GridServlet",
            prepManager: "https://prepmanager-dub.amazon.com/view",
            boxRec: "https://box-web-dub.amazon.com/BoxRecBrowser/getBoxRecommendation",
        },
        features: {
            quickPrintBar: { default: true, label: "Quick Print Bar", description: "Top bar to quickly print barcodes and ASINs" },
            asinPrinting: { default: true, label: "ASIN Print Buttons", description: "Automatic print buttons on product pages" },
            fcSelector: { default: true, label: "FC Selector", description: "Buttons to switch between different fulfillment centers" },
            altClickDiver: { default: true, label: "Alt+Click Diver", description: "Alt+Click on any text to open it in Diver" },
            floorInfo: { default: true, label: "Floor Information", description: "Shows the bin location information in the inventory" },
            flipsCounter: { default: true, label: "Flips Counter", description: "Real-time counter of Flips to Sellable quantities" },
            darkMode: { default: false, label: "Dark Mode", description: "Toggle between light and dark theme" },
            imageHover: { default: true, label: "Image Hover", description: "Show product images when hovering over ASINs" },
            badgePhotos: { default: true, label: "Badge Photos", description: "Show employee photos when hovering over logins" },
            hazmatInfo: { default: true, label: "Hazmat Information", description: "Show Hazmat level from PanDash on product pages" },
            prepInfo: { default: true, label: "Prep Instructions", description: "Show certified Prep instructions from Prep Instruction Manager" },
            boxRecInfo: { default: true, label: "Box Recommendation", description: "Show recommended box from Box Recommendation Browser" },
            dataMatrixGenerator: { default: true, label: "DataMatrix Generator", description: "Generate scannable Data Matrix codes from a list of bins with grid view and history" },
            receiveHistoryFilters: { default: true, label: "Receive History Filters", description: "Quick filter buttons for Processing path in Receive History" },
        },
        hazmat: {
            marketplace: "ES", cacheDuration: 300000, timeout: 5000,
            capabilities: { RMU1:"MEDIUM",BCN4:"MEDIUM",MAD4:"MEDIUM",LCJ1:"MEDIUM",ZAZ1:"MEDIUM",CDG7:"MEDIUM",WRO5:"MEDIUM",DTM2:"MEDIUM",HAJ1:"MEDIUM" },
            levels: { 0:{bg:"#f0f0f0",text:"#555555",label:"No Hazmat"},1:{bg:"#e8f5e9",text:"#2e7d32",label:"Level 1"},2:{bg:"#f1f8e9",text:"#558b2f",label:"Level 2"},3:{bg:"#fffde7",text:"#f9a825",label:"Level 3"},4:{bg:"#fff3e0",text:"#e65100",label:"Level 4"},5:{bg:"#fbe9e7",text:"#bf360c",label:"Level 5"},6:{bg:"#ffebee",text:"#c62828",label:"Level 6"},7:{bg:"#f3e5f5",text:"#6a1b9a",label:"Level 7"} },
        },
        prep: { cacheDuration: 300000, timeout: 10000 },
        boxRec: { cacheDuration: 300000, timeout: 10000, fcMarketplace: { RMU1:44551,ZAZ1:44551,BCN4:44551,MAD4:44551,LCJ1:44551,CDG7:5,WRO5:712115121,DTM2:4,HAJ1:4 } },
        dmx: { historyMax: 5, historyKey: "dmx-history", concurrency: 5, bwipSources: ["https://cdn.jsdelivr.net/npm/bwip-js@4.1.1/dist/bwip-js-min.js","https://unpkg.com/bwip-js@4.1.1/dist/bwip-js-min.js","https://cdnjs.cloudflare.com/ajax/libs/bwip-js/4.1.1/bwip-js-min.js"] },
        receiveHistory: { dataColCandidates: ["receive-history-process-path","receive-history-processing-path","receive-history-processPath","receive-history-path"], table: "#table-receive-history", filterSuffix: "_filter" },
        diver: { dateRangeMonths:1, showConfirmation:false, autoSearchMaxAttempts:20, autoSearchDelay:500 },
        performance: { debounceDelay:300, imageCache:{maxSize:100,ttl:3600000}, elementCache:{ttl:5000}, retryAttempts:3, timeout:5000 },
        ui: { delays:{instant:0,short:100,medium:300,long:500,veryLong:1000}, toastDuration:3000 },
        patterns: { asin:/^(B0|X0)[A-Z0-9]{8}$/, po:/^[0-9][A-Z0-9]{7}$/, login:/^[a-zA-Z]{4,15}@?$/, date:/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}(?:\s[A-Z]+)?$/ },
        dateTables: ["#table-inventory-history","#table-receive-history","#table-container-history"],
        rsValues: ["M","F","R","X"],
        loginBlacklist: ["SYSTEM","AUTO","AUTOMATED","UNKNOWN","NULL","ROBOT","BOT","SCRIPT","ADMIN"],
    };

    // ========================================
    // LOGGER
    // ========================================
    const Logger = {
        levels:{DEBUG:0,INFO:1,WARN:2,ERROR:3}, currentLevel:1,
        log(level,message,data={}) { if(this.levels[level]<this.currentLevel)return; const e={DEBUG:"D",INFO:"I",WARN:"W",ERROR:"E"}; const t=new Date().toISOString().split("T")[1].split(".")[0]; const p=`[${e[level]}][${t}]`; Object.keys(data).length>0?console.log(`${p} ${message}`,data):console.log(`${p} ${message}`); },
        debug:(m,d)=>Logger.log("DEBUG",m,d), info:(m,d)=>Logger.log("INFO",m,d),
        warn:(m,d)=>Logger.log("WARN",m,d), error:(m,d)=>Logger.log("ERROR",m,d),
    };

    // ========================================
    // [OPT 1.1] UNIFIED TTL CACHE
    // ========================================
    class TTLCache {
        constructor(ttl, maxSize = Infinity) {
            this.ttl = ttl;
            this.maxSize = maxSize;
            this.cache = new Map();
            this.timestamps = new Map();
        }
        set(key, value) {
            if (this.cache.size >= this.maxSize) this._evictOldest();
            this.cache.set(key, value);
            this.timestamps.set(key, Date.now());
        }
        get(key) {
            if (!this.cache.has(key)) return null;
            if (Date.now() - this.timestamps.get(key) > this.ttl) { this.delete(key); return null; }
            return this.cache.get(key);
        }
        delete(key) { this.cache.delete(key); this.timestamps.delete(key); }
        clear() { this.cache.clear(); this.timestamps.clear(); }
        get size() { return this.cache.size; }
        _evictOldest() {
            let oldestKey = null, oldestTime = Infinity;
            for (const [k, t] of this.timestamps) { if (t < oldestTime) { oldestTime = t; oldestKey = k; } }
            if (oldestKey) this.delete(oldestKey);
        }
        getStats() { return { size: this.cache.size, maxSize: this.maxSize, usage: `${Math.round((this.cache.size / this.maxSize) * 100)}%` }; }
    }

    const hazmatCache = new TTLCache(CONFIG.hazmat.cacheDuration);
    const prepCache = new TTLCache(CONFIG.prep.cacheDuration);
    const boxRecCache = new TTLCache(CONFIG.boxRec.cacheDuration);
    const imageCache = new TTLCache(CONFIG.performance.imageCache.ttl, CONFIG.performance.imageCache.maxSize);
    const elementCache = new TTLCache(CONFIG.performance.elementCache.ttl);

    // Element cache with DOM validation
    const ElementCache = {
        get(s) { const c = elementCache.get(s); if (c && !document.contains(c)) { elementCache.delete(s); return null; } return c; },
        set(s, e) { elementCache.set(s, e); return e; },
        clear() { elementCache.clear(); },
        getOrFind(s) { let e = this.get(s); if (!e) { e = document.querySelector(s); if (e) this.set(s, e); } return e; },
    };

    // ========================================
    // [OPT 2.4] UNIFIED TOAST + SAFE EXECUTION
    // ========================================
    const SafeExecute = {
        async run(fn, ctx = "Operation", showErr = false) {
            try { return await fn(); } catch (e) {
                Logger.error(`${ctx} failed`, { error: e.message });
                if (showErr) this.toast(`${ctx} failed.`, "error");
                return null;
            }
        },
        toast(msg, type = "success") {
            $(".fcr-toast").remove();
            const colors = { success: "#28a745", error: "#dc3545", info: "#0d6efd", warning: "#ff9900" };
            const icons = { success: "OK", error: "!!", info: "ℹ", warning: "⚠" };
            const bg = colors[type] || colors.success;
            const icon = icons[type] || icons.success;
            const t = $(`<div class="fcr-toast" style="position:fixed;bottom:80px;right:20px;background:${bg};color:white;padding:1rem 1.5rem;border-radius:0.5rem;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:100000;font-size:0.875rem;font-weight:600;animation:slideIn 0.3s ease-out;max-width:300px;">${icon} ${msg}</div>`);
            $("body").append(t);
            setTimeout(() => t.fadeOut(300, () => t.remove()), CONFIG.ui.toastDuration);
        },
    };

    // ========================================
    // EVENT BUS
    // ========================================
    const EventBus = {
        events: {},
        on(e, cb) { if (!this.events[e]) this.events[e] = []; this.events[e].push(cb); },
        emit(e, d) { if (!this.events[e]) return; this.events[e].forEach(cb => { try { cb(d); } catch (er) { Logger.error(`Event handler failed for ${e}`, { error: er.message }); } }); },
        off(e, cb) { if (!this.events[e]) return; this.events[e] = this.events[e].filter(c => c !== cb); },
    };

    // ========================================
    // VALIDATORS
    // ========================================
    const Validators = {
        isValidASIN(t) { return t ? CONFIG.patterns.asin.test(t.trim()) : false; },
        isValidPO(t) { return t ? CONFIG.patterns.po.test(t.trim()) : false; },
        isValidLogin(t) { if (!t || t.length < 4 || t.length > 15) return false; if (!CONFIG.patterns.login.test(t)) return false; return !CONFIG.loginBlacklist.includes(t.toUpperCase().replace("@", "")); },
        isValidDate(t) { return t ? CONFIG.patterns.date.test(t) : false; },
        isLoginInURL() { const s = new URLSearchParams(window.location.search).get("s"); if (!s) return false; return CONFIG.patterns.login.test(s.trim()) && !this.isValidASIN(s.trim()) && !this.isValidPO(s.trim()); },
    };

    // ========================================
    // STATE
    // ========================================
    const STATE = {
        currentFC: null, activeRSFilter: null, flipsToSellableActive: false,
        setFC(fc) { const o = this.currentFC; this.currentFC = fc; if (o !== fc) EventBus.emit("fc:changed", { old: o, new: fc }); },
        setRSFilter(v) { const o = this.activeRSFilter; this.activeRSFilter = v; if (o !== v) EventBus.emit("rsfilter:changed", { old: o, new: v }); },
        setFlipsToSellable(a) { const o = this.flipsToSellableActive; this.flipsToSellableActive = a; if (o !== a) EventBus.emit("flips:changed", { active: a }); },
    };

    // ========================================
    // [OPT 1.7] SHARED DOM PARSER
    // ========================================
    const domParser = new DOMParser();

    // ========================================
    // UTILS
    // ========================================
    const Utils = {
        getCurrentFC() { const m = window.location.pathname.match(/\/([A-Z0-9]{3,4})\//); return m ? m[1] : GM_getValue("selectedFC", CONFIG.warehouses.default); },
        asciihex: s => s.split("").map(c => c.charCodeAt(0).toString(16)).join(""),
        genId: () => Math.random().toString(36).substr(2, 10),
        normalizeText: t => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim(),
        // [OPT 2.3] Modern clipboard API with fallback
        async copyToClipboard(t) {
            try { await navigator.clipboard.writeText(t); } catch {
                const tmp = document.createElement("textarea");
                tmp.value = t; tmp.style.position = "fixed"; tmp.style.opacity = "0";
                document.body.appendChild(tmp); tmp.select();
                document.execCommand("copy"); tmp.remove();
            }
            SafeExecute.toast("Copied to clipboard");
        },
        debounce(fn, d) { let tid; return function (...a) { clearTimeout(tid); tid = setTimeout(() => fn.apply(this, a), d); }; },
        waitForElement(sel, timeout = 5000) {
            return new Promise((res, rej) => {
                const el = document.querySelector(sel); if (el) return res(el);
                const obs = new MutationObserver(() => { const e = document.querySelector(sel); if (e) { obs.disconnect(); res(e); } });
                obs.observe(document.body, { childList: true, subtree: true });
                setTimeout(() => { obs.disconnect(); rej(new Error(`Element ${sel} not found`)); }, timeout);
            });
        },
        isFeatureEnabled: f => $.cookie(`cfg-${f}`) === "1",
        initializeCookies() { Object.keys(CONFIG.features).forEach(f => { if (typeof $.cookie(`cfg-${f}`) === "undefined") $.cookie(`cfg-${f}`, CONFIG.features[f].default ? "1" : "0"); }); },
        setDateInput(input, fd) {
            input.removeAttribute("readonly"); input.focus(); input.value = "";
            fd.split("").forEach(c => { input.value += c; input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: c, inputType: "insertText" })); });
            input.value = fd;
            ["input", "change", "blur", "keyup", "keydown"].forEach(ev => input.dispatchEvent(new Event(ev, { bubbles: true, cancelable: true })));
            if (typeof $ !== "undefined") $(input).val(fd).trigger("input").trigger("change").trigger("blur");
            input.blur();
        },
        // [OPT 1.2] Throttled parallel execution
        async runThrottled(items, concurrency, fn) {
            const queue = [...items];
            const workers = Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
                while (queue.length > 0) { const item = queue.shift(); await fn(item); }
            });
            await Promise.all(workers);
        },
    };

    STATE.setFC(Utils.getCurrentFC());

    // ========================================
    // [OPT 1.5] PRODUCT TABLE WATCHER — MutationObserver based
    // ========================================
    const ProductTableWatcher = {
        callbacks: [], started: false, table: null, observer: null,
        findProductTable() { for (let t of document.querySelectorAll("table")) { if (t.textContent.includes("B0") && t.textContent.match(/\d+\.\d+\s*x\s*\d+\.\d+\s*x\s*\d+\.\d+/i)) return t; } return null; },
        findDimensionsRow(table) { for (let r of table.querySelectorAll("tr")) { if (r.textContent.match(/\d+\.\d+\s*x\s*\d+\.\d+\s*x\s*\d+\.\d+/i)) return r; } return null; },
        extractASINFromTable(table) { for (let row of table.querySelectorAll("tr")) { const c = row.querySelectorAll("th, td"); if (c.length >= 2 && c[0].textContent.trim().toUpperCase().includes("ASIN")) { const t = (c[1].querySelector("a")?.textContent || c[1].textContent).trim(); if (/^B0[A-Z0-9]{8}$/.test(t)) return t; } } return null; },
        notifyCallbacks(table) {
            this.table = table; Logger.info("Product table found");
            this.callbacks.forEach(cb => { try { cb(table); } catch (e) { Logger.error("ProductTableWatcher callback failed", { error: e.message }); } });
        },
        onReady(cb) { this.callbacks.push(cb); if (this.table) try { cb(this.table); } catch (e) { Logger.error("ProductTableWatcher callback failed", { error: e.message }); } },
        init() {
            if (this.started) return; this.started = true;
            if (!window.location.href.includes("/results?s=")) return;
            const table = this.findProductTable();
            if (table) { this.notifyCallbacks(table); return; }
            this.observer = new MutationObserver(() => {
                const t = this.findProductTable();
                if (t) { this.observer.disconnect(); this.observer = null; this.notifyCallbacks(t); }
            });
            this.observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { if (this.observer) { this.observer.disconnect(); this.observer = null; } }, 6000);
        },
        reset() { if (this.observer) { this.observer.disconnect(); this.observer = null; } this.started = false; this.table = null; this.callbacks = []; },
    };

    // ========================================
    // [OPT 2.1] PRODUCT INTEGRATION BASE CLASS
    // ========================================
    class ProductIntegration {
        constructor(name, featureKey, rowClass, labelText, loadingText, loadingCssClass) {
            this.name = name;
            this.featureKey = featureKey;
            this.rowClass = rowClass;
            this.labelText = labelText;
            this.loadingText = loadingText;
            this.loadingCssClass = loadingCssClass;
            this.initialized = false;
            this.dataPromise = null;
            this.requestId = 0;
        }
        init() {
            if (!Utils.isFeatureEnabled(this.featureKey)) return;
            if (this.initialized) return;
            if (!window.location.href.includes("/results?s=")) return;
            Logger.info(`${this.name} integration starting`);
            ProductTableWatcher.onReady(table => this.insertRow(table));
            this.initialized = true;
        }
        async fetchData(asin) { throw new Error("fetchData must be overridden"); }
        updateCell(cell, data) { throw new Error("updateCell must be overridden"); }
        findInsertionPoint(table) {
            return ProductTableWatcher.findDimensionsRow(table);
        }
        async insertRow(table) {
            let att = 0; const maxAtt = 20;
            const currentRequestId = ++this.requestId;
            const tryInsert = async () => {
                if (table.querySelector(`.${this.rowClass}`)) return;
                const asin = ProductTableWatcher.extractASINFromTable(table); if (!asin) return;
                const insertionPoint = this.findInsertionPoint(table);
                if (!insertionPoint) { if (++att < maxAtt) setTimeout(tryInsert, 300); return; }
                this.dataPromise = this.fetchData(asin);
                const newRow = document.createElement("tr"); newRow.className = this.rowClass;
                const labelCell = document.createElement("th"); labelCell.className = `${this.rowClass}-label`; labelCell.textContent = this.labelText;
                const valueCell = document.createElement("td"); valueCell.className = `${this.rowClass}-value ${this.loadingCssClass}`; valueCell.textContent = this.loadingText;
                newRow.appendChild(labelCell); newRow.appendChild(valueCell);
                insertionPoint.parentNode.insertBefore(newRow, insertionPoint.nextSibling);
                try {
                    const data = await this.dataPromise;
                    if (this.requestId !== currentRequestId) return;
                    this.updateCell(valueCell, data);
                } catch (e) {
                    if (this.requestId !== currentRequestId) return;
                    this.showError(valueCell, e);  // ◄── FIXED: passes the full error, not e.message
                }
            };
            tryInsert();
        }
        showError(cell, err) {
            cell.className = `${this.rowClass}-value ${this.rowClass}-error`;
            const msg = typeof err === "string" ? err : (err?.message || `Error querying ${this.name}`);
            cell.textContent = "⚠ " + msg;
        }
        reset() {
            this.initialized = false;
            this.dataPromise = null;
            this.requestId++;
        }
    }


    // ========================================
    // HAZMAT INTEGRATION
    // ========================================
    class HazmatIntegrationClass extends ProductIntegration {
        constructor() {
            super("Hazmat", "hazmatInfo", "hazmat-row", "Hazmat Level", "Querying PanDash...", "hazmat-loading");
        }
        init() {
            if (!Utils.getCurrentFC()) return;
            super.init();
        }
        getFCCapability(fc) { return CONFIG.hazmat.capabilities[fc] || "MEDIUM"; }
        async fetchData(asin) {
            const fc = Utils.getCurrentFC(); const mp = CONFIG.hazmat.marketplace;
            const cacheKey = `${asin}_${fc}_${mp}`;
            const cached = hazmatCache.get(cacheKey); if (cached) return cached;
            return new Promise((resolve, reject) => {
                const src = `${this.getFCCapability(fc)}-hazmat-FC`;
                const params = new URLSearchParams({ language: "default", source: src, marketPlaces: mp, asins: asin, sidx: "product.asin", rows: "1", page: "1", sord: "desc", isExportOnly: "FALSE", fileName: `fcr_${Date.now()}`, fc, pandashservice: "" });
                GM_xmlhttpRequest({
                    method: "POST", url: CONFIG.endpoints.pandash,
                    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
                    data: params.toString(), timeout: CONFIG.hazmat.timeout,
                    onload: r => {
                        try {
                            if (r.status !== 200) { reject(new Error("HTTP " + r.status)); return; }
                            const j = JSON.parse(r.responseText);
                            if (!j.rows || j.rows.length === 0) { reject(new Error("No Hazmat data")); return; }
                            const row = j.rows[0];
                            const res = { level: parseInt(row.level) || 0, message: row.message || "Not available", asin };
                            hazmatCache.set(cacheKey, res); resolve(res);
                        } catch (e) { reject(e); }
                    },
                    onerror: () => reject(new Error("Network error")), ontimeout: () => reject(new Error("Timeout"))
                });
            });
        }
        updateCell(cell, data) {
            const li = CONFIG.hazmat.levels[data.level] || CONFIG.hazmat.levels[0];
            cell.className = "hazmat-row-value";
            cell.textContent = `Level ${data.level}: ${data.message}`;
            cell.style.backgroundColor = li.bg; cell.style.color = li.text;
            cell.style.padding = "10px"; cell.style.fontWeight = "bold";
            cell.title = `Level ${data.level} - PanDash`;
        }
    }
    const HazmatIntegration = new HazmatIntegrationClass();

    // ========================================
    // PREP INSTRUCTION INTEGRATION
    // ========================================
    class PrepIntegrationClass extends ProductIntegration {
        constructor() {
            super("Prep", "prepInfo", "prep-row", "Certified Prep", "Querying Prep Manager...", "prep-loading");
        }
        findInsertionPoint(table) {
            return table.querySelector(".hazmat-row") || ProductTableWatcher.findDimensionsRow(table);
        }
        async fetchData(asin) {
            const cached = prepCache.get(asin); if (cached) return cached;
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET", url: `${CONFIG.endpoints.prepManager}/${asin}`, timeout: CONFIG.prep.timeout,
                    onload: (response) => {
                        try {
                            if (response.status !== 200) { reject(new Error("HTTP " + response.status)); return; }
                            const doc = domParser.parseFromString(response.responseText, "text/html");
                            const div = doc.querySelector("#instructions");
                            if (!div) { const res = { items: [], raw: "Prep not certified yet", noPrep: false }; prepCache.set(asin, res); resolve(res); return; }
                            const items = div.querySelectorAll("ul li");
                            if (items.length > 0) { const texts = Array.from(items).map(li => li.textContent.trim()); const res = { items: texts, raw: texts.join(" / "), noPrep: false }; prepCache.set(asin, res); resolve(res); return; }
                            const divText = div.textContent || "";
                            if (divText.includes("Certified No Prep")) { const res = { items: [], raw: "Certified: No Prep", noPrep: true }; prepCache.set(asin, res); resolve(res); }
                            else { const res = { items: [], raw: "Prep not certified yet", noPrep: false }; prepCache.set(asin, res); resolve(res); }
                        } catch (error) { reject(error); }
                    },
                    onerror: () => reject(new Error("Network error")), ontimeout: () => reject(new Error("Timeout"))
                });
            });
        }
        updateCell(cell, data) {
            if (data.items.length > 0) cell.className = "prep-row-value prep-has-items";
            else if (data.noPrep) cell.className = "prep-row-value prep-certified-no";
            else cell.className = "prep-row-value prep-no-items";
            cell.textContent = data.raw;
        }
    }
    const PrepInstructionIntegration = new PrepIntegrationClass();

    // ========================================
    // BOX RECOMMENDATION INTEGRATION
    // ========================================
    class BoxRecIntegrationClass extends ProductIntegration {
        constructor() {
            super("Box Recommendation", "boxRecInfo", "boxrec-row", "Box Recommendation", "Querying Box Recommendation...", "boxrec-loading");
        }
        findInsertionPoint(table) {
            return table.querySelector(".prep-row") || table.querySelector(".hazmat-row") || ProductTableWatcher.findDimensionsRow(table);
        }
        async fetchData(asin) {
            const fc = Utils.getCurrentFC();
            const cacheKey = `${asin}_${fc}`;
            const cached = boxRecCache.get(cacheKey); if (cached) return cached;
            return new Promise((resolve, reject) => {
                const marketplaceId = CONFIG.boxRec.fcMarketplace[fc] || 44551;
                const url = `${CONFIG.endpoints.boxRec}?marketplaceId=${marketplaceId}&marketplace-selector=${marketplaceId}&warehouseId=${fc}&asin=${asin}&shipOption=&fulfillmentBrandCodeString=&giftOption=NoGift&siocOverride=NONE&_packingBrands=on&_packingBrands=on&_packingBrands=on&_requiresConcealment=on&postalCode=`;
                GM_xmlhttpRequest({
                    method: "GET", url, timeout: CONFIG.boxRec.timeout,
                    onload: (response) => {
                        try {
                            if (response.status !== 200) { reject(new Error("HTTP " + response.status)); return; }
                            const doc = domParser.parseFromString(response.responseText, "text/html");
                            let displayNameIndex = -1, targetTable = null;
                            doc.querySelectorAll("table").forEach(table => { table.querySelectorAll("th").forEach((th, idx) => { if (th.textContent.trim().toLowerCase().includes("display name")) { displayNameIndex = idx; targetTable = table; } }); });
                            if (targetTable && displayNameIndex >= 0) {
                                const dataRows = targetTable.querySelectorAll("tbody tr");
                                const rows = dataRows.length > 0 ? dataRows : Array.from(targetTable.querySelectorAll("tr")).slice(1);
                                const displayNames = [];
                                rows.forEach(row => { const cells = row.querySelectorAll("td"); if (cells.length > displayNameIndex) { const name = cells[displayNameIndex].textContent.trim(); if (name) displayNames.push(name); } });
                                const result = displayNames.length > 0 ? { items: displayNames, raw: displayNames.join(" / ") } : { items: [], raw: "No recommended box" };
                                boxRecCache.set(cacheKey, result); resolve(result);
                            } else { const result = { items: [], raw: "No recommended box" }; boxRecCache.set(cacheKey, result); resolve(result); }
                        } catch (error) { reject(error); }
                    },
                    onerror: () => reject({ type: "network", loginUrl: "https://box-web-dub.amazon.com/" }),
                    ontimeout: () => reject(new Error("Timeout"))
                });
            });
        }
        updateCell(cell, data) {
            cell.className = "boxrec-row-value" + (data.items.length > 0 ? " boxrec-has-items" : " boxrec-no-items");
            cell.textContent = data.raw;
        }
        showError(cell, err) {
            cell.className = "boxrec-row-value boxrec-error"; cell.textContent = "";
            const prefix = document.createTextNode("⚠ ");
            cell.appendChild(prefix);
            if (err && typeof err === "object" && err.loginUrl) {
                cell.appendChild(document.createTextNode("Network error, log in "));
                const link = document.createElement("a");
                link.href = err.loginUrl; link.target = "_blank";
                link.textContent = "box-web-dub.amazon.com";
                link.style.color = "#0066c0"; link.style.textDecoration = "underline";
                cell.appendChild(link);
            } else {
                const msg = typeof err === "string" ? err : (err?.message || "Error querying Box Recommendation");
                cell.appendChild(document.createTextNode(msg));
            }
        }
    }
    const BoxRecIntegration = new BoxRecIntegrationClass();


    // ========================================
    // DIVER UTILITIES
    // ========================================
    const DiverUtils = {
        formatDateForDiver(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; },
        buildDiverUrl(searchText, fc = null) {
            if (!fc) fc = STATE.currentFC || Utils.getCurrentFC();
            const t = new Date(); const ed = this.formatDateForDiver(t);
            const sd = new Date(); sd.setMonth(sd.getMonth() - CONFIG.diver.dateRangeMonths); const sds = this.formatDateForDiver(sd);
            return { url: `${CONFIG.endpoints.diver}?destination_warehouse_id=${fc}&end_date=${ed}&search=${encodeURIComponent(searchText)}&source_warehouse_id=-&start_date=${sds}`, fc, startDate: sds, endDate: ed };
        },
        openInDiver(searchText, fc = null) {
            if (!Utils.isFeatureEnabled("altClickDiver")) return;
            if (!searchText || searchText.length === 0) { SafeExecute.toast("No text to search in Diver", "error"); return; }
            if (searchText.length > 100) { SafeExecute.toast("Text too long", "error"); return; }
            const { url } = this.buildDiverUrl(searchText, fc);
            window.open(url, "_blank");
            SafeExecute.toast(`Opening Diver: ${searchText.length > 30 ? searchText.substring(0, 30) + "..." : searchText}`);
        },
    };

    // ========================================
    // DIVER AUTO-SEARCH
    // ========================================
    const DiverAutoSearch = {
        initialized: false,
        SEARCH_SELECTORS: [
            'button[type="submit"]',
            'button.awsui-button-variant-primary',
            '[data-testid="search-button"]',
            'button[aria-label*="Search"]',
            'button[aria-label*="search"]',
        ],
        init() {
            if (!window.location.href.includes("diver.qts.amazon.dev")) return;
            if (this.initialized) return; this.initialized = true;
            const hs = new URLSearchParams(window.location.search).get("search");
            if (!hs) return; this.waitAndClickSearch();
        },
        async waitAndClickSearch() {
            for (let a = 1; a <= CONFIG.diver.autoSearchMaxAttempts; a++) {
                const b = this.findSearchButton();
                if (b) {
                    await new Promise(r => setTimeout(r, 300));
                    try { b.click(); b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); this.showNotification("Search triggered automatically"); return; } catch (e) { }
                }
                if (a < CONFIG.diver.autoSearchMaxAttempts) await new Promise(r => setTimeout(r, CONFIG.diver.autoSearchDelay));
            }
        },
        // [OPT 2.5] Simplified search button finder
        findSearchButton() {
            for (const sel of this.SEARCH_SELECTORS) {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
            }
            return Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Search" && !b.disabled && b.offsetParent !== null) || null;
        },
        showNotification(msg) {
            const n = document.createElement("div"); n.textContent = `OK ${msg}`;
            n.style.cssText = "position:fixed;top:20px;right:20px;background:#28a745;color:white;padding:0.5rem 1rem;border-radius:0.25rem;font-size:0.875rem;z-index:100000;opacity:0;transition:opacity 0.3s ease;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,0.2);";
            document.body.appendChild(n); setTimeout(() => (n.style.opacity = "1"), 10);
            setTimeout(() => { n.style.opacity = "0"; setTimeout(() => n.remove(), 300); }, 2000);
        },
    };

    // ========================================
    // [OPT 4.1 + 5.1] NAVIGATION DETECTOR — EventBus based
    // ========================================
    const NavigationDetector = {
        lastUrl: location.href, reinitTimer: null,
        init() {
            const obs = new MutationObserver(() => {
                if (location.href !== this.lastUrl) { this.lastUrl = location.href; this.onNavigate(); }
            });
            const te = document.querySelector("title");
            if (te) obs.observe(te, { childList: true, subtree: true });
            window.addEventListener("popstate", () => this.onNavigate());
        },
        onNavigate() {
            if (this.reinitTimer) clearTimeout(this.reinitTimer);
            Logger.info("SPA Navigation detected", { url: location.href });
            ElementCache.clear();
            STATE.setFC(Utils.getCurrentFC());
            EventBus.emit("navigation", { url: location.href });
            ProductTableWatcher.reset();
            this.reinitTimer = setTimeout(() => reinitializeDynamicElements(), CONFIG.ui.delays.medium);
        },
    };

    // ========================================
    // PRINTER
    // ========================================
    const Printer = {
        send(barcode, quantity, badge = "", description = "") {
            return SafeExecute.run(async () => {
                const eb = Utils.asciihex(barcode.trim()); const ed = description ? Utils.asciihex(description) : "";
                const p = `action=print&type=barcode&data=${eb}&text=${eb}&quantity=${quantity}&badgeid=${badge}&desc=${ed}&seq=${Utils.genId()}`;
                return new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET", url: CONFIG.endpoints.printHost + "?" + p, timeout: CONFIG.performance.timeout,
                        onload: r => {
                            const s = { valid: () => { SafeExecute.toast(`Printed ${quantity}x ${barcode}`); resolve(true); }, invalid: () => { alert("Failed to print!\nCheck printer."); reject(new Error("Printer error")); }, default: () => { alert("Failed to print!\nPrintmon not installed!"); reject(new Error("Printmon not installed")); } };
                            (s[r.responseText] || s.default)();
                        },
                        onerror: () => { alert("Failed to connect to Printmon."); reject(new Error("Connection error")); }
                    });
                });
            }, "Print", false);
        },
        showBarcode(text) {
            $(".barcode-modal").remove();
            const modal = $('<div class="barcode-modal"></div>'); const content = $('<div class="barcode-content"></div>');
            const canvas = $("<canvas></canvas>"); const closeBtn = $('<button class="barcode-close">Close</button>');
            content.append(canvas, closeBtn); modal.append(content); $("body").append(modal);
            try { JsBarcode(canvas[0], text, { format: "CODE128", width: 2, height: 100, displayValue: true }); } catch (e) { content.html('<p style="color:red;">Failed to generate barcode</p>'); }
            closeBtn.on("click", () => modal.remove());
            modal.on("click", e => { if (e.target === modal[0]) modal.remove(); });
        },
    };

    // ========================================
    // ASIN TITLE FETCHER
    // ========================================
    const AsinTitle = {
        getFromPage(asin) {
            for (let table of document.querySelectorAll("table.a-keyvalue")) {
                for (let row of table.querySelectorAll("tr")) {
                    const c = row.querySelectorAll("th, td"); if (c.length < 2) continue;
                    const h = Utils.normalizeText(c[0].textContent);
                    if (h === "TITLE" || h === "TITULO") { const v = (c[1].querySelector("a")?.textContent || c[1].textContent).trim(); if (v && v.length > 5) return v; }
                }
            }
            return null;
        },
        async fetch(asin) {
            return SafeExecute.run(async () => new Promise(resolve => {
                const fc = $.cookie("fcmenu-warehouseId") || STATE.currentFC; if (!fc) return resolve("No Title Found");
                GM_xmlhttpRequest({
                    method: "POST", url: `${CONFIG.endpoints.base}/${fc}/results/product`,
                    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, data: `s=${asin}`, timeout: CONFIG.performance.timeout,
                    onload: r => {
                        try {
                            const doc = domParser.parseFromString(r.responseText, "text/html");
                            for (let table of doc.querySelectorAll("table.a-keyvalue")) {
                                for (let row of table.querySelectorAll("tr")) {
                                    const c = row.querySelectorAll("th, td"); if (c.length < 2) continue;
                                    const h = Utils.normalizeText(c[0].textContent);
                                    if (h === "TITLE" || h === "TITULO") { const title = (c[1].querySelector("a")?.textContent || c[1].textContent).trim(); if (title && title.length > 5) return resolve(title); }
                                }
                            }
                            resolve("No Title Found");
                        } catch (e) { resolve("No Title Found"); }
                    },
                    onerror: () => resolve("No Title Found")
                });
            }), `Fetch ASIN Title: ${asin}`, false);
        },
    };

    // ========================================
    // [OPT 2.2] DIALOG TEMPLATES
    // ========================================
    const DialogTemplates = {
        _closeAll() { $('#print-dialog-backdrop, [id^="print-dialog-"], #fnsku-warning-dialog').remove(); },
        _createBackdrop() {
            const backdrop = $('<div id="print-dialog-backdrop">').css({ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: "rgba(0,0,0,0.5)", zIndex: 9999 });
            return backdrop;
        },
        _createDialogBox(borderColor = "#232f3e") {
            return $("<div>").css({ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", backgroundColor: "#ffffff", padding: "1.5625rem", border: `2px solid ${borderColor}`, borderRadius: "0.5rem", boxShadow: "0 0.25rem 1.25rem rgba(0,0,0,0.3)", zIndex: 10000, color: "#000", fontFamily: "Arial,sans-serif", minWidth: "25rem", maxWidth: "31.25rem" });
        },
        showFnskuWarning(fnsku, onPrintFnsku, onPrintAsin) {
            this._closeAll();
            const backdrop = this._createBackdrop();
            const dialog = this._createDialogBox("#e65100").attr("id", "fnsku-warning-dialog").html(`<h3 style="margin:0 0 0.9375rem 0;color:#e65100;font-size:1.125rem;border-bottom:2px solid #e65100;padding-bottom:0.625rem;">⚠ FNSku available</h3><p style="margin:0.9375rem 0;color:#333;font-size:0.875rem;line-height:1.6;">This product has an associated <strong>FNSku</strong>:</p><div style="margin:0.75rem 0;padding:0.75rem;background:#fff3e0;border-radius:0.375rem;border:1px solid #ffcc02;text-align:center;"><span style="font-family:monospace;font-size:1.1rem;font-weight:700;color:#e65100;">${fnsku}</span></div><p style="margin:0.9375rem 0 0;color:#333;font-size:0.875rem;line-height:1.6;">The FNSku has <strong>priority over the ASIN</strong> for labeling. What would you like to print?</p><div style="display:flex;gap:0.625rem;margin-top:1.25rem;padding-top:0.9375rem;border-top:1px solid #eee;"><button id="warning-print-fnsku" style="flex:1;padding:0.625rem 1.25rem;cursor:pointer;background-color:#183D3D;border:none;border-radius:0.25rem;color:white;font-weight:bold;font-size:0.875rem;">✓ Print FNSku</button><button id="warning-print-asin" style="flex:1;padding:0.625rem 1.25rem;cursor:pointer;background-color:#f0f0f0;border:1px solid #ccc;border-radius:0.25rem;color:#333;font-size:0.875rem;">Print ASIN</button><button id="warning-cancel" style="padding:0.625rem 1.25rem;cursor:pointer;background-color:#f0f0f0;border:1px solid #ccc;border-radius:0.25rem;color:#333;font-size:0.875rem;">Cancel</button></div>`);
            $("body").append(backdrop, dialog);
            const close = () => { dialog.remove(); backdrop.remove(); };
            backdrop.click(close); $("#warning-cancel").click(close);
            // [OPT 3.3] Escape to close
            const escHandler = e => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); } };
            document.addEventListener("keydown", escHandler);
            $("#warning-print-fnsku").click(() => { close(); onPrintFnsku(); });
            $("#warning-print-asin").click(() => { close(); onPrintAsin(); });
        },
        showPrintDialog(code, type, title, onPrint, onBarcode) {
            this._closeAll();
            const backdrop = this._createBackdrop();
            const dialog = this._createDialogBox().attr("id", `print-dialog-${code}`).html(`<h3 style="margin:0 0 0.9375rem 0;color:#232f3e;font-size:1.125rem;border-bottom:2px solid #ff9900;padding-bottom:0.625rem;">Print ${type}: <span style="color:#ff9900;">${code}</span></h3><p style="margin:0.9375rem 0;color:#000;font-size:0.875rem;line-height:1.5;"><strong>Title:</strong> ${title}</p><div style="margin:1.25rem 0;display:flex;align-items:center;gap:0.625rem;"><label for="qtyNum" style="font-weight:bold;font-size:0.875rem;">Quantity:</label><input type="number" id="qtyNum" min="1" max="50" value="1" style="padding:0.5rem 0.75rem;width:5rem;border:2px solid #ddd;border-radius:0.25rem;font-size:0.875rem;"><button id="printBtn" style="padding:0.625rem 1.25rem;cursor:pointer;background-color:#ff9900;border:none;border-radius:0.25rem;color:white;font-weight:bold;font-size:0.875rem;">Print</button><button id="barcodeBtn" style="padding:0.625rem 1.25rem;cursor:pointer;background-color:#183D3D;border:none;border-radius:0.25rem;color:white;font-weight:bold;font-size:0.875rem;">Show Barcode</button></div><div style="text-align:right;margin-top:1.5625rem;padding-top:0.9375rem;border-top:1px solid #eee;"><button id="cancelBtn" style="padding:0.625rem 1.25rem;cursor:pointer;background-color:#f0f0f0;border:1px solid #ccc;border-radius:0.25rem;color:#333;font-size:0.875rem;">Cancel</button></div>`);
            $("body").append(backdrop, dialog);
            const close = () => { dialog.remove(); backdrop.remove(); };
            backdrop.click(close); $("#cancelBtn").click(close);
            const escHandler = e => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); } };
            document.addEventListener("keydown", escHandler);
            $("#printBtn").click(() => { const q = parseInt($("#qtyNum").val(), 10); if (q > 0) { onPrint(q); close(); } else { alert("Please enter a quantity greater than 0"); } });
            $("#barcodeBtn").click(() => onBarcode());
            $("#qtyNum").keypress(e => { if (e.key === "Enter") $("#printBtn").click(); });
            $("#qtyNum").focus().select();
        },
    };

    // ========================================
    // ASIN PRINTING
    // ========================================
    const AsinPrinting = {
        productData: { asin: "", fnsku: "", title: "No Title Found" },
        async addButtons() {
            if (!Utils.isFeatureEnabled("asinPrinting")) return;
            return SafeExecute.run(async () => {
                ProductTableWatcher.onReady(table => {
                    if (table.querySelector(".asin-print-button")) return;
                    const rows = table.querySelectorAll("tr"); let asinRow = null, fnskuRow = null;
                    this.productData = { asin: "", fnsku: "", title: "No Title Found" };
                    for (let row of rows) {
                        const cells = row.querySelectorAll("th, td"); if (cells.length < 2) continue;
                        const nh = Utils.normalizeText(cells[0].textContent);
                        const value = (cells[1].querySelector("a")?.textContent || cells[1].textContent).trim();
                        if (nh === "ASIN") { this.productData.asin = value; asinRow = row; }
                        if (nh === "FNSKU") { this.productData.fnsku = value; fnskuRow = row; }
                        if (nh === "TITLE" || nh === "TITULO") this.productData.title = value;
                    }
                    if (this.productData.fnsku && fnskuRow) this.addButtonToRow(fnskuRow, this.productData.fnsku, "FNSku", false);
                    if (this.productData.asin && asinRow) this.addButtonToRow(asinRow, this.productData.asin, "ASIN", !!(this.productData.fnsku && fnskuRow));
                });
            }, "Add ASIN Print Buttons", false);
        },
        addButtonToRow(row, code, type, showFnskuWarning) {
            const cells = row.querySelectorAll("th, td"); if (cells.length < 2) return;
            const cell = cells[1]; if (cell.querySelector(".asin-print-button")) return;
            const btn = document.createElement("button"); btn.className = "asin-print-button"; btn.textContent = `Print ${type}`;
            btn.addEventListener("click", () => {
                if (showFnskuWarning) {
                    DialogTemplates.showFnskuWarning(this.productData.fnsku,
                        () => this.openPrintDialog(this.productData.fnsku, "FNSku"),
                        () => this.openPrintDialog(this.productData.asin, "ASIN"));
                } else { this.openPrintDialog(code, type); }
            });
            cell.appendChild(btn);
        },
        openPrintDialog(code, type) {
            DialogTemplates.showPrintDialog(code, type, this.productData.title,
                (qty) => Printer.send(code, qty, $.cookie("fcmenu-employeeId") || "", this.productData.title),
                () => Printer.showBarcode(code));
        },
        async handleFromMenu(asin) {
            const ld = $("<div>").css({ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", backgroundColor: "#ffffff", padding: "1.25rem", border: "2px solid #232f3e", borderRadius: "0.5rem", boxShadow: "0 0.25rem 1.25rem rgba(0,0,0,0.3)", zIndex: 10001, color: "#000", fontFamily: "Arial,sans-serif" }).html("<p>Loading ASIN information...</p>");
            $("body").append(ld);
            try { let title = AsinTitle.getFromPage(asin); if (!title) title = await AsinTitle.fetch(asin); ld.remove(); this.productData.title = title || "No Title Found"; this.openPrintDialog(asin, "ASIN"); } catch (e) { ld.remove(); alert("Error loading ASIN information."); }
        },
    };

    // ========================================
    // ALT+CLICK DIVER
    // ========================================
    const AltClickDiver = {
        init() {
            if (!Utils.isFeatureEnabled("altClickDiver")) return;
            document.body.addEventListener("click", async event => {
                if (event.altKey && !event.ctrlKey && !event.shiftKey) {
                    event.preventDefault(); event.stopPropagation();
                    let t = event.target.innerText.split("\n")[0].trim();
                    if (t && t.length > 0) DiverUtils.openInDiver(t); return;
                }
                if (event.altKey && event.shiftKey && !event.ctrlKey) {
                    event.preventDefault(); event.stopPropagation();
                    let bt = event.target.innerText.split("\n")[0].trim();
                    if (!bt) { SafeExecute.toast("No text to print", "error"); return; }
                    if (bt.includes("LPN")) { if (!confirm(`Barcode: ${bt}\n\nLPN's are unique.\n\nOK to continue.`)) return; Printer.send(bt, 1, $.cookie("fcmenu-employeeId") || "", ""); }
                    else { const am = bt.match(/\b(B0|X0)[A-Z0-9]{8}\b/); if (am) { let title = AsinTitle.getFromPage(am[0]); if (!title) title = await AsinTitle.fetch(am[0]); Printer.send(am[0], 1, $.cookie("fcmenu-employeeId") || "", title); } else Printer.send(bt, 1, $.cookie("fcmenu-employeeId") || "", ""); }
                    SafeExecute.toast(`Printed: ${bt}`); return;
                }
            }, false);
        },
    };

    // ========================================
    // CONTEXT MENU
    // ========================================
    const ContextMenu = {
        LINKS: [
            { name: "Copy", action: t => Utils.copyToClipboard(t) },
            { name: "Open in New Tab", url: t => `${CONFIG.endpoints.base}/${$.cookie("fcmenu-warehouseId") || STATE.currentFC}/results?s=${t}` },
            { name: "Open in Diver", action: t => DiverUtils.openInDiver(t) },
            { name: "Sacred Timeline", url: t => `https://eu-west-1.prod.sacred-timeline.aft.amazon.dev/searchMaterials?searchValue=${t}` },
            { name: "Open in TT SIM", url: t => { const query = { "AND": { "keyword": `(${t})`, "status": { "OR": ["Assigned", { "OR": ["Work In Progress", { "OR": ["Researching", { "OR": ["Pending", { "OR": ["Resolved", "Closed"] }] }] }] }] } } }; return `https://t.corp.amazon.com/issues?q=${encodeURIComponent(JSON.stringify(query))}`; } },
            { separator: true },
            { name: "Print", action: t => { const am = t.match(/\b(B0|X0)[A-Z0-9]{8}\b/); if (am) { AsinPrinting.handleFromMenu(am[0]); } else { const q = prompt("How many labels?", "1"); if (q && parseInt(q) > 0) Printer.send(t, q); } } },
            { name: "Show Barcode", action: t => Printer.showBarcode(t) },
            { separator: true },
            { name: "Amazon.com", url: t => `https://amazon.com/dp/${t}` }
        ],
        initialized: false,
        init() {
            if (this.initialized) return;
            $(document).on("contextmenu", e => {
                const sel = window.getSelection().toString(); if (sel && sel.length > 0) return true;
                if ($(e.target).is("input, select, textarea, button")) return true;
                const $t = $(e.target); const $l = $t.is("a") ? $t : $t.closest("a");
                let txt = ($l.length ? $l : $t).text().trim();
                if (!txt || txt.length === 0 || txt.length > 200) return true;
                const asinMatch = txt.match(/\b(B0|X0)[A-Z0-9]{8}\b/);
                const poMatch = txt.match(/\b[0-9][A-Z0-9]{7}\b/);
                const value = asinMatch ? asinMatch[0] : poMatch ? poMatch[0] : txt.length < 50 ? txt : null;
                if (value) { this.create(e, value); return false; } return true;
            });
            this.initialized = true;
        },
        create(event, value) {
            if (!value || !value.trim()) return; event.preventDefault(); event.stopPropagation();
            $(".custom-context-menu").remove();
            const menu = $('<div class="custom-context-menu">');
            let mx = event.clientX, my = event.clientY;
            menu.css({ position: "fixed", top: my + "px", left: mx + "px", zIndex: 10000, visibility: "hidden" });
            this.LINKS.forEach(link => {
                if (link.separator) { menu.append("<hr/>"); return; }
                const item = $(`<div class="menu-item">${link.name}</div>`);
                if (link.action) item.on("click", () => { link.action(value); menu.remove(); });
                else if (link.url) item.on("click", () => { window.open(link.url(value), "_blank"); menu.remove(); });
                menu.append(item);
            });
            $("body").append(menu);
            const mw = menu.outerWidth(), mh = menu.outerHeight(), ww = $(window).width(), wh = $(window).height();
            if (mx + mw > ww) mx = ww - mw - 10; if (my + mh > wh) my = wh - mh - 10;
            if (mx < 0) mx = 10; if (my < 0) my = 10;
            menu.css({ top: my + "px", left: mx + "px", visibility: "visible" });
            $(document).one("click contextmenu", () => menu.remove());
        },
    };

    // ========================================
    // FLIPS TO SELLABLE
    // ========================================
    const FlipsToSellable = {
        config: { selectors: { oldOwner: 'tr[data-col="inventory-history-old-owner"]', newOwner: 'tr[data-col="inventory-history-new-owner"]', searchButton: 'span[data-action="inventory-history-search-button"]', table: "#table-inventory-history" }, values: { oldOwner: "unsellable", newOwner: "inventory" } },
        counterElement: null, tableObserver: null, quantityColumnIndex: null,
        findInput(row) { return row.querySelector('input[type="text"]') || row.querySelector("input.a-input-text") || row.querySelector("input"); },
        validateFilters() { const oR = document.querySelector(this.config.selectors.oldOwner); const nR = document.querySelector(this.config.selectors.newOwner); if (!oR || !nR) throw new Error("Advanced filters not open"); const oI = this.findInput(oR), nI = this.findInput(nR); if (!oI || !nI) throw new Error("Filter inputs not found"); return { oldOwnerInput: oI, newOwnerInput: nI }; },
        setInputValue(input, value) { input.value = value; input.focus(); ["input", "change", "keyup", "blur"].forEach(ev => input.dispatchEvent(new Event(ev, { bubbles: true }))); if (typeof $ !== "undefined") $(input).trigger("input").trigger("change"); },
        findQuantityColumnIndex() {
            if (this.quantityColumnIndex !== null) return this.quantityColumnIndex;
            const hr = document.querySelector("#table-inventory-history_wrapper .dataTables_scrollHead thead tr") || document.querySelector(this.config.selectors.table + " thead tr");
            if (hr) hr.querySelectorAll("th").forEach((th, i) => { const t = th.textContent.trim().toLowerCase(); if (t.includes("cantidad") || t.includes("quantity") || t.includes("qty")) this.quantityColumnIndex = i + 1; });
            return this.quantityColumnIndex || 7;
        },
        calculateQuantitySum() {
            let total = 0; const table = document.querySelector(this.config.selectors.table); if (!table) return 0;
            const ci = this.findQuantityColumnIndex();
            table.querySelectorAll("tbody tr").forEach(row => {
                if (window.getComputedStyle(row).display !== "none") {
                    let qc = row.querySelector(`td:nth-child(${ci})`);
                    if (!qc || !/^\d+$/.test(qc.textContent.trim())) for (let c of row.querySelectorAll("td")) if (/^\d+$/.test(c.textContent.trim())) { qc = c; break; }
                    if (qc) total += parseInt(qc.textContent.trim(), 10) || 0;
                }
            });
            return total;
        },
        updateCounter() { if (!this.counterElement || !Utils.isFeatureEnabled("flipsCounter")) return; this.counterElement.textContent = `Total: ${this.calculateQuantitySum()}`; this.counterElement.style.display = "inline-block"; },
        startTableObserver() { if (this.tableObserver) this.tableObserver.disconnect(); const table = document.querySelector(this.config.selectors.table); if (!table) return; this.tableObserver = new MutationObserver(Utils.debounce(() => { if (STATE.flipsToSellableActive) this.updateCounter(); }, 500)); this.tableObserver.observe(table, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] }); },
        stopTableObserver() { if (this.tableObserver) { this.tableObserver.disconnect(); this.tableObserver = null; } },
        async toggle() {
            return SafeExecute.run(async () => {
                const { oldOwnerInput, newOwnerInput } = this.validateFilters();
                if (STATE.flipsToSellableActive) {
                    this.setInputValue(oldOwnerInput, ""); this.setInputValue(newOwnerInput, "");
                    STATE.setFlipsToSellable(false); if (this.counterElement) this.counterElement.style.display = "none";
                    this.stopTableObserver(); SafeExecute.toast("Flips filter cleared");
                } else {
                    this.setInputValue(oldOwnerInput, this.config.values.oldOwner); this.setInputValue(newOwnerInput, this.config.values.newOwner);
                    STATE.setFlipsToSellable(true); await new Promise(r => setTimeout(r, 2000));
                    this.startTableObserver(); this.updateCounter(); SafeExecute.toast("Flips filter applied");
                }
                return STATE.flipsToSellableActive;
            }, "Toggle Flips to Sellable", true);
        },
        createButton() {
            if (!Validators.isLoginInURL()) return;
            const sb = document.querySelector(this.config.selectors.searchButton); if (!sb || document.getElementById("flipsToSellableButton")) return;
            this.insertButton(this.buildButton(), sb.parentElement);
        },
        buildButton() {
            const w = document.createElement("span"); w.id = "flipsToSellableButtonContainer"; w.className = "a-declarative"; w.style.cssText = "margin-left:0.625rem;display:inline-flex;align-items:center;gap:0.5rem;";
            const bw = document.createElement("span"); bw.className = "a-button a-button-base";
            const bi = document.createElement("span"); bi.className = "a-button-inner";
            const btn = document.createElement("button"); btn.id = "flipsToSellableButton"; btn.className = "a-button-text"; btn.type = "button"; btn.textContent = "Flips to Sellable";
            btn.addEventListener("click", async e => { e.preventDefault(); e.stopPropagation(); const s = await this.toggle(); if (s !== null) bw.classList.toggle("flips-active", s); });
            bi.appendChild(btn); bw.appendChild(bi); w.appendChild(bw);
            this.counterElement = document.createElement("span"); this.counterElement.id = "flips-quantity-counter"; this.counterElement.textContent = "Total: 0"; w.appendChild(this.counterElement);
            return w;
        },
        insertButton(button, parent) {
            const tb = document.getElementById("todayButtonContainer"); const mrb = document.getElementById("maxRangeButtonContainer");
            const sb = document.querySelector(this.config.selectors.searchButton);
            if (tb) parent.insertBefore(button, tb.nextSibling); else if (mrb) parent.insertBefore(button, mrb.nextSibling); else parent.insertBefore(button, sb.nextSibling);
        },
    };

    // ========================================
    // RECEIVE HISTORY FILTERS
    // ========================================
    const ReceiveHistoryFilters = {
        activeFilter: null, filterRow: null, dataCol: null, initialized: false,
        getContainerId() { return CONFIG.receiveHistory.table.replace("#", "") + CONFIG.receiveHistory.filterSuffix; },
        init() {
            if (!Utils.isFeatureEnabled("receiveHistoryFilters")) return; if (document.querySelector(".rh-filter-buttons-container")) return;
            const filterDiv = document.getElementById(this.getContainerId()); if (!filterDiv) return;
            const discovered = this.discoverFilterRow(); if (!discovered) return;
            this.filterRow = discovered.row; this.dataCol = discovered.dataCol;
            const select = this.getFilterSelect(this.filterRow); if (!select) return;
            const options = this.getSelectOptions(select); if (options.length === 0) return;
            this.createButtons(filterDiv, select, options); this.startSyncObserver(select); this.initialized = true;
        },
        discoverFilterRow() { for (const col of CONFIG.receiveHistory.dataColCandidates) { const row = document.querySelector(`tr[data-col="${col}"]`); if (row) return { row, dataCol: col }; } const allRows = document.querySelectorAll("tr[data-col*='receive']"); for (const row of allRows) { const col = row.getAttribute("data-col"); if (col.includes("path") || col.includes("process")) return { row, dataCol: col }; } return null; },
        getFilterSelect(filterRow) { return filterRow.querySelector("select.a-input-text") || filterRow.querySelector("select"); },
        getSelectOptions(select) { const options = []; select.querySelectorAll("option").forEach(opt => { const val = opt.textContent.trim(); if (val && val.length > 0 && val !== "" && val !== "-") options.push(val); }); return options; },
        createButtons(filterDiv, select, options) {
            const container = document.createElement("div"); container.className = "rh-filter-buttons-container";
            options.forEach(value => {
                const btn = document.createElement("button"); btn.className = "rh-filter-button"; btn.textContent = value; btn.dataset.filterValue = value;
                btn.addEventListener("click", (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (this.activeFilter === value) { this.activeFilter = null; select.value = ""; btn.classList.remove("active"); }
                    else { this.activeFilter = value; select.value = value; if (select.value !== value) { for (const opt of select.options) { if (opt.textContent.trim() === value) { select.value = opt.value; break; } } } container.querySelectorAll(".rh-filter-button").forEach(b => b.classList.remove("active")); btn.classList.add("active"); }
                    select.dispatchEvent(new Event("change", { bubbles: true }));
                });
                container.appendChild(btn);
            });
            filterDiv.insertBefore(container, filterDiv.firstChild);
        },
        startSyncObserver(select) {
            const syncButtons = () => { const container = document.querySelector(".rh-filter-buttons-container"); if (!container) return; const currentText = select.options[select.selectedIndex]?.textContent.trim() || ""; container.querySelectorAll(".rh-filter-button").forEach(btn => { const btnVal = btn.dataset.filterValue; if (currentText && btnVal === currentText) { btn.classList.add("active"); this.activeFilter = btnVal; } else { btn.classList.remove("active"); } }); if (!currentText || select.value === "") this.activeFilter = null; };
            select.addEventListener("change", syncButtons); $(select).on("change", syncButtons);
            new MutationObserver(() => { const newOptions = this.getSelectOptions(select); const container = document.querySelector(".rh-filter-buttons-container"); if (!container) return; const currentButtons = Array.from(container.querySelectorAll(".rh-filter-button")).map(b => b.dataset.filterValue); if (JSON.stringify(newOptions) !== JSON.stringify(currentButtons)) { container.remove(); this.activeFilter = null; const filterDiv = document.getElementById(this.getContainerId()); if (filterDiv) { this.createButtons(filterDiv, select, newOptions); this.startSyncObserver(select); } } }).observe(select, { childList: true, subtree: true });
        },
        reset() { this.activeFilter = null; this.filterRow = null; this.dataCol = null; this.initialized = false; $(".rh-filter-buttons-container").remove(); },
    };

    // ========================================
    // DATAMATRIX GENERATOR
    // ========================================
    const DataMatrixGenerator = {
        initialized: false, bwipLoaded: false, keydownHandler: null,
        floorData: new Map(), activeFloorFilter: null, pendingRequests: 0,

        init() { if (!Utils.isFeatureEnabled("dataMatrixGenerator")) return; if (this.initialized) return; if (window.location.href.includes("diver.qts.amazon.dev")) return; Logger.info("DataMatrix Generator starting"); this.loadBwipJs().then(() => { Logger.info("bwip-js ready"); this.bwipLoaded = true; this.createTriggerButton(); }).catch(err => { Logger.error("bwip-js load failed", { error: err.message }); this.bwipLoaded = false; this.createTriggerButton(); }); this.initialized = true; },
        loadBwipJs() { return new Promise((resolve, reject) => { if (typeof bwipjs !== "undefined") { resolve(); return; } const sources = CONFIG.dmx.bwipSources; let index = 0; function tryNext() { if (index >= sources.length) { reject(new Error("Could not load bwip-js")); return; } const script = document.createElement("script"); script.src = sources[index]; script.onload = () => resolve(); script.onerror = () => { index++; tryNext(); }; document.head.appendChild(script); } tryNext(); }); },
        historyLoad() { try { return JSON.parse(GM_getValue(CONFIG.dmx.historyKey, "[]")); } catch (e) { return []; } },
        historySave(bins) { if (!bins || bins.length === 0) return; const history = this.historyLoad(); const entry = { bins, date: new Date().toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }), count: bins.length }; const key = bins.join(","); const filtered = history.filter(h => h.bins.join(",") !== key); filtered.unshift(entry); if (filtered.length > CONFIG.dmx.historyMax) filtered.length = CONFIG.dmx.historyMax; GM_setValue(CONFIG.dmx.historyKey, JSON.stringify(filtered)); },
        historyClear() { GM_setValue(CONFIG.dmx.historyKey, "[]"); },
        isGridVisible() { const gv = document.getElementById("dmx-grid-view"); return gv && gv.style.display !== "none"; },
        parseBins(raw) { return raw.split(/[\n,]+/).map(b => b.trim()).filter(b => b.length > 0).filter((b, i, arr) => arr.indexOf(b) === i); },
        createTriggerButton() { if (document.getElementById("dmx-trigger")) return; const btn = document.createElement("button"); btn.id = "dmx-trigger"; btn.title = "Bin DataMatrix Generator"; btn.innerHTML = "⠿"; btn.addEventListener("click", () => this.openModal()); document.body.appendChild(btn); },
        removeTriggerButton() { const btn = document.getElementById("dmx-trigger"); if (btn) btn.remove(); },
        openModal() {
            if (document.getElementById("dmx-backdrop")) return;
            if (!this.bwipLoaded) { SafeExecute.toast("The barcode library has not loaded yet.", "error"); return; }
            const backdrop = document.createElement("div"); backdrop.id = "dmx-backdrop";
            backdrop.innerHTML = `<div id="dmx-modal"><div id="dmx-header"><span>⠿ Bin DataMatrix Generator</span><button id="dmx-close">&times;</button></div><div id="dmx-body"><div id="dmx-input-view"><textarea id="dmx-textarea" placeholder="Paste the bins here, one per line:&#10;&#10;P-1-A01B02&#10;P-2-C03D04&#10;P-3-E05F06"></textarea><div id="dmx-hint">Separate bins by line break, comma or space</div><div id="dmx-error"></div><div id="dmx-actions"><button id="dmx-generate">Generate Data Matrix</button><button id="dmx-clear">Clear</button></div><div id="dmx-history"></div></div><div id="dmx-grid-view" style="display:none;"><div id="dmx-grid-header"><span id="dmx-grid-count"></span><div style="display:flex;gap:8px;"><button id="dmx-print">🖨 Print</button><button id="dmx-back">← Back</button></div></div><div id="dmx-floor-filters"></div><div id="dmx-grid"></div></div></div></div>`;
            document.body.appendChild(backdrop);
            document.getElementById("dmx-close").addEventListener("click", () => this.closeModal());
            backdrop.addEventListener("click", e => { if (e.target !== backdrop) return; if (this.isGridVisible()) return; this.closeModal(); });
            this.keydownHandler = (e) => { if (e.key === "Escape") this.closeModal(); };
            document.addEventListener("keydown", this.keydownHandler);
            document.getElementById("dmx-generate").addEventListener("click", () => this.generate());
            document.getElementById("dmx-clear").addEventListener("click", () => { document.getElementById("dmx-textarea").value = ""; document.getElementById("dmx-textarea").focus(); });
            document.getElementById("dmx-back").addEventListener("click", () => this.showInputView());
            document.getElementById("dmx-print").addEventListener("click", () => window.print());
            this.renderHistory(); setTimeout(() => document.getElementById("dmx-textarea").focus(), 100);
        },
        closeModal() { const backdrop = document.getElementById("dmx-backdrop"); if (backdrop) backdrop.remove(); if (this.keydownHandler) { document.removeEventListener("keydown", this.keydownHandler); this.keydownHandler = null; } },
        renderHistory() { const container = document.getElementById("dmx-history"); if (!container) return; const history = this.historyLoad(); const count = history.length; let html = `<button id="dmx-history-toggle"><span id="dmx-history-arrow">▶</span>📋 History ${count > 0 ? `<span id="dmx-history-badge">${count}</span>` : ""}</button><div id="dmx-history-content">`; if (count === 0) { html += `<div id="dmx-history-empty">No history</div>`; } else { html += `<div id="dmx-history-actions"><button id="dmx-history-clear">Clear all</button></div><div id="dmx-history-list">`; history.forEach((entry, i) => { const preview = entry.bins.join(", "); html += `<div class="dmx-history-item" data-index="${i}"><span class="dmx-history-count">${entry.count}</span><span class="dmx-history-bins" title="${preview}">${preview}</span><span class="dmx-history-date">${entry.date}</span></div>`; }); html += "</div>"; } html += "</div>"; container.innerHTML = html; const toggle = document.getElementById("dmx-history-toggle"); const content = document.getElementById("dmx-history-content"); const arrow = document.getElementById("dmx-history-arrow"); toggle.addEventListener("click", () => { const isOpen = content.classList.toggle("open"); arrow.classList.toggle("open", isOpen); }); container.querySelectorAll(".dmx-history-item").forEach(item => { item.addEventListener("click", () => { const idx = parseInt(item.dataset.index); const entry = history[idx]; if (!entry) return; document.getElementById("dmx-textarea").value = entry.bins.join("\n"); document.getElementById("dmx-textarea").focus(); }); }); const clearBtn = document.getElementById("dmx-history-clear"); if (clearBtn) { clearBtn.addEventListener("click", e => { e.stopPropagation(); this.historyClear(); this.renderHistory(); }); } },
        generate() { const textarea = document.getElementById("dmx-textarea"); const error = document.getElementById("dmx-error"); const btn = document.getElementById("dmx-generate"); const bins = this.parseBins(textarea.value); if (bins.length === 0) { error.textContent = "No valid bins found."; error.style.display = "block"; return; } error.style.display = "none"; btn.disabled = true; btn.dataset.originalText = btn.textContent; btn.textContent = "⏳ Generating..."; setTimeout(() => { this.historySave(bins); this.showGridView(bins); btn.disabled = false; btn.textContent = btn.dataset.originalText; }, 50); },
        showInputView() { document.getElementById("dmx-input-view").style.display = "block"; document.getElementById("dmx-grid-view").style.display = "none"; this.renderHistory(); },
        showGridView(bins) {
            document.getElementById("dmx-input-view").style.display = "none";
            document.getElementById("dmx-grid-view").style.display = "block";
            document.getElementById("dmx-grid-count").textContent = `${bins.length} bin${bins.length !== 1 ? "s" : ""}`;
            const grid = document.getElementById("dmx-grid"); grid.innerHTML = "";
            const filtersContainer = document.getElementById("dmx-floor-filters"); if (filtersContainer) filtersContainer.innerHTML = "";
            bins.forEach(bin => {
                const card = document.createElement("div"); card.className = "dmx-card"; card.dataset.bin = bin;
                const canvas = document.createElement("canvas");
                const label = document.createElement("div"); label.className = "dmx-card-label"; label.textContent = bin;
                card.appendChild(canvas); card.appendChild(label); grid.appendChild(card);
                try { bwipjs.toCanvas(canvas, { bcid: "datamatrix", text: bin, scale: 4, padding: 1, backgroundcolor: "FFFFFF" }); } catch (err) { canvas.remove(); const errDiv = document.createElement("div"); errDiv.className = "dmx-card-error"; errDiv.textContent = "Error generating"; card.insertBefore(errDiv, label); }
            });
            this.fetchFloorDataForBins(bins);
        },
        // [OPT 1.2] Throttled floor data fetching
        async fetchFloorDataForBins(bins) {
            const fc = Utils.getCurrentFC(); if (!fc) return;
            this.floorData.clear(); this.activeFloorFilter = null; this.pendingRequests = bins.length;
            const filtersContainer = document.getElementById("dmx-floor-filters");
            if (filtersContainer) filtersContainer.innerHTML = '<span class="dmx-floor-loading">Loading floors…</span>';
            await Utils.runThrottled(bins, CONFIG.dmx.concurrency, (bin) => {
                return new Promise(resolve => {
                    FloorInfo.fetchBinData(bin, fc, (data) => {
                        this.pendingRequests--;
                        this.floorData.set(bin, data && !data.error && data.dropzone ? data.dropzone : null);
                        this.renderFloorFilters();
                        if (this.pendingRequests <= 0) { const el = document.querySelector(".dmx-floor-loading"); if (el) el.remove(); }
                        resolve();
                    });
                });
            });
        },
        renderFloorFilters() {
            const container = document.getElementById("dmx-floor-filters"); if (!container) return;
            const floors = new Set(); let unknownCount = 0;
            for (const [, dropzone] of this.floorData) { if (dropzone) floors.add(dropzone); else unknownCount++; }
            if (floors.size === 0 && unknownCount === 0) return;
            const loadingHtml = this.pendingRequests > 0 ? `<span class="dmx-floor-loading">Loading… (${this.pendingRequests})</span>` : "";
            const sorted = Array.from(floors).sort();
            let html = '<div class="dmx-floor-buttons">';
            html += `<button class="dmx-floor-btn${this.activeFloorFilter === null ? " active" : ""}" data-floor="__all__">All <span class="dmx-floor-btn-count">${this.floorData.size}</span></button>`;
            sorted.forEach(floor => { let count = 0; for (const [, dz] of this.floorData) { if (dz === floor) count++; } html += `<button class="dmx-floor-btn${this.activeFloorFilter === floor ? " active" : ""}" data-floor="${floor}">${floor} <span class="dmx-floor-btn-count">${count}</span></button>`; });
            if (unknownCount > 0) html += `<button class="dmx-floor-btn${this.activeFloorFilter === "__unknown__" ? " active" : ""}" data-floor="__unknown__">N/A <span class="dmx-floor-btn-count">${unknownCount}</span></button>`;
            html += '</div>' + loadingHtml; container.innerHTML = html;
            container.querySelectorAll(".dmx-floor-btn").forEach(btn => { btn.addEventListener("click", () => { const f = btn.dataset.floor; this.applyFloorFilter(f === "__all__" ? null : f); }); });
        },
        applyFloorFilter(floor) {
            this.activeFloorFilter = (this.activeFloorFilter === floor && floor !== null) ? null : floor;
            const cards = document.querySelectorAll(".dmx-card"); let visibleCount = 0;
            cards.forEach(card => {
                const dz = this.floorData.get(card.dataset.bin);
                const show = this.activeFloorFilter === null ? true : this.activeFloorFilter === "__unknown__" ? !dz : dz === this.activeFloorFilter;
                card.style.display = show ? "" : "none"; if (show) visibleCount++;
            });
            this.updateGridCount(visibleCount, cards.length); this.renderFloorFilters();
        },
        updateGridCount(visible, total) {
            const counter = document.getElementById("dmx-grid-count"); if (!counter) return;
            counter.textContent = (this.activeFloorFilter === null || visible === total) ? `${total} bin${total !== 1 ? "s" : ""}` : `${visible} of ${total} bin${total !== 1 ? "s" : ""}`;
        },
    };

    // ========================================
    // [OPT 1.6] FLOOR INFO — MutationObserver based scanner
    // ========================================
    const FloorInfo = {
        floorVisible: false, floorLoaded: false, scanObserver: null,
        cache: new Map(), requestTimeout: 8000,

        formatDropzone(raw) { const m = raw.match(/^dz-P-(A0[234])$/i); return m ? `paKiva${m[1]}` : raw; },
        parseDropzone(doc) {
            for (const table of doc.querySelectorAll("table")) {
                for (const row of table.querySelectorAll("tr")) {
                    const cells = row.querySelectorAll("th, td");
                    for (let i = 0; i < cells.length - 1; i++) {
                        const header = cells[i].textContent.trim().toLowerCase();
                        const value = cells[i + 1].textContent.trim();
                        if (header.includes("dropzone") && value) return { dropzone: this.formatDropzone(value) };
                    }
                }
            }
            return null;
        },
        fetchBinData(binId, fc, callback) {
            const cached = this.cache.get(binId); if (cached) { callback(cached); return; }
            GM_xmlhttpRequest({
                method: "POST", url: `${CONFIG.endpoints.base}/${fc}/results/container-hierarchy`,
                headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
                data: `s=${encodeURIComponent(binId)}`, timeout: this.requestTimeout,
                onload: (response) => { try { if (response.status !== 200) { callback({ error: true }); return; } const doc = domParser.parseFromString(response.responseText, "text/html"); const data = this.parseDropzone(doc); if (data) this.cache.set(binId, data); callback(data || { error: true }); } catch (e) { callback({ error: true }); } },
                onerror: () => callback({ error: true }), ontimeout: () => callback({ error: true }),
            });
        },
        processRows(fc) {
            let n = 0;
            $("#table-inventory tbody tr").each(function () {
                const $td = $(this).find("td:nth-child(1)");
                if (!$td.length || $td.hasClass("ff-processed")) return;
                const binId = $td.text().trim(); if (!binId) return;
                const $cell = $('<td class="ff-col"><span class="ff-loading">···</span></td>');
                $td.after($cell); $td.addClass("ff-processed"); n++;
                FloorInfo.fetchBinData(binId, fc, (data) => {
                    if (data.error) $cell.html('<div class="ff-error">N/A</div>');
                    else $cell.html(`<div class="ff-ok">${data.dropzone}</div>`);
                });
            });
            return n;
        },
        find() {
            if (!Utils.isFeatureEnabled("floorInfo") || $(".ff-col-header").length > 0) return;
            [$("#table-inventory_wrapper .dataTables_scrollHead thead tr"), $("#table-inventory thead tr")].forEach($r => {
                if ($r.length && !$r.find(".ff-col-header").length) { const $ch = $r.find("th:nth-child(1)"); if ($ch.length) $ch.after('<th class="ff-col-header sorting_disabled">Floor</th>'); }
            });
            const $rows = $("#table-inventory tbody tr"); if (!$rows.length) return;
            $("#table-inventory").parent().css({ height: "auto", "max-height": "800px" });
            const fc = Utils.getCurrentFC(); if (!fc) return;
            this.processRows(fc); this.startScanner();
        },
        startScanner() {
            if (this.scanObserver) return;
            const tbody = document.querySelector("#table-inventory tbody"); if (!tbody) return;
            const fc = Utils.getCurrentFC(); if (!fc) return;
            this.scanObserver = new MutationObserver(Utils.debounce(() => {
                if (!this.floorLoaded) return;
                const n = this.processRows(fc);
                if (n > 0) Logger.debug(`FloorInfo: +${n} new bins`);
            }, 500));
            this.scanObserver.observe(tbody, { childList: true });
        },
        stopScanner() { if (this.scanObserver) { this.scanObserver.disconnect(); this.scanObserver = null; } },
        hide() { $(".ff-col-header").hide(); $(".ff-col").hide(); },
        show() { $(".ff-col-header").show(); $(".ff-col").show(); },
        attachButton() {
            if (!Utils.isFeatureEnabled("floorInfo")) return;
            const ib = $('.section-placeholder[data-section-type="inventory"]');
            if (!ib.length || $(".ff-btn-container").length) return;
            const $container = $('<div class="ff-btn-container"></div>');
            const $btn = $('<button class="ff-btn">Show bin floor</button>');
            $btn.on("click", function () {
                if (!FloorInfo.floorLoaded) { FloorInfo.find(); FloorInfo.floorLoaded = true; FloorInfo.floorVisible = true; $(this).text("Hide bin floor").addClass("active"); }
                else if (FloorInfo.floorVisible) { FloorInfo.hide(); FloorInfo.floorVisible = false; $(this).text("Show bin floor").removeClass("active"); }
                else { FloorInfo.show(); FloorInfo.floorVisible = true; $(this).text("Hide bin floor").addClass("active"); }
            });
            $container.append($btn); ib.before($container);
        },
        reset() { this.stopScanner(); this.floorLoaded = false; this.floorVisible = false; this.cache.clear(); $(".ff-btn-container").remove(); $(".ff-col-header").remove(); $(".ff-col").remove(); $(".ff-processed").removeClass("ff-processed"); },
    };

    // ========================================
    // SETTINGS MENU
    // ========================================
    const SettingsMenu = {
        container: null, button: null, isOpen: false,
        init() { this.addSwitchStyles(); },
        addSwitchStyles() { GM_addStyle(`.fcr-switch{position:relative;display:inline-block;width:50px;height:26px;flex-shrink:0;}.fcr-switch input{opacity:0;width:0;height:0;}.fcr-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:#ccc;transition:0.3s;border-radius:26px;}.fcr-slider:before{position:absolute;content:"";height:20px;width:20px;left:3px;bottom:3px;background-color:white;transition:0.3s;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.2);}.fcr-switch input:checked+.fcr-slider{background-color:#28a745;}.fcr-switch input:checked+.fcr-slider:before{transform:translateX(24px);}.fcr-setting-item{margin-bottom:16px;display:flex;align-items:flex-start;gap:12px;padding:8px;border-radius:8px;transition:background 0.2s;}.fcr-setting-item:hover{background:rgba(24,61,61,0.05);}.fcr-setting-info{flex-grow:1;text-align:left;min-width:0;overflow:hidden;}.fcr-setting-label{font-weight:600;color:#183D3D;font-size:0.875rem;margin-bottom:4px;text-align:left;word-wrap:break-word;overflow-wrap:break-word;}.fcr-setting-desc{font-size:0.75rem;color:#666;line-height:1.4;text-align:left;word-wrap:break-word;overflow-wrap:break-word;word-break:break-word;}#fcr-settings-toggle{width:2rem;height:2rem;border-radius:50%;border:2px solid #183D3D;background:white;color:#183D3D;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:1rem;transition:all 0.3s ease;flex-shrink:0;position:relative;z-index:1001;margin-left:0.3125rem;padding:0;}#fcr-settings-toggle:hover{transform:scale(1.1);background:#f0f0f0;}#fcr-controls-container{display:inline-flex;gap:0.3125rem;align-items:center;flex-shrink:0;position:relative;z-index:1000;order:12;}.fcr-fc-label{font-weight:600;color:#183D3D;font-size:0.8rem;display:block;margin-bottom:4px;}.fcr-fc-input{width:100%;padding:6px 10px;border:2px solid #ddd;border-radius:6px;font-size:0.8rem;font-family:monospace;box-sizing:border-box;transition:border-color 0.3s;}.fcr-fc-input:focus{border-color:#183D3D;outline:none;}.fcr-fc-save-btn{width:100%;padding:8px 16px;background:#183D3D;color:white;border:none;border-radius:6px;font-weight:600;font-size:0.8rem;cursor:pointer;transition:all 0.3s;margin-top:8px;}.fcr-fc-save-btn:hover{background:#2C5D5D;transform:translateY(-1px);}`); },
        createButton() {
            if (document.getElementById("fcr-settings-toggle")) return;
            this.button = $('<button id="fcr-settings-toggle" title="FCResearch+ Settings">⚙️</button>');
            this.button.on("click", e => { e.preventDefault(); e.stopPropagation(); this.toggle(); });
            const cc = $("#fcr-controls-container"); if (cc.length) cc.append(this.button); this.createMenu();
        },
        createMenu() {
            if (this.container) return;
            const pf = ["quickPrintBar", "asinPrinting", "fcSelector", "altClickDiver", "floorInfo", "flipsCounter", "hazmatInfo", "prepInfo", "boxRecInfo", "dataMatrixGenerator", "receiveHistoryFilters"];
            const of2 = Object.keys(CONFIG.features).filter(f => !pf.includes(f));
            let html = '<div style="margin-bottom:20px;"><h4 style="margin:0 0 15px 0;color:#183D3D;font-size:0.9rem;font-weight:600;">Core Features</h4>';
            pf.forEach(f => { if (CONFIG.features[f]) html += this.generateSettingHtml(f, CONFIG.features[f]); }); html += "</div>";
            if (of2.length > 0) { html += '<div><h4 style="margin:0 0 15px 0;color:#183D3D;font-size:0.9rem;font-weight:600;">Additional Features</h4>'; of2.forEach(f => html += this.generateSettingHtml(f, CONFIG.features[f])); html += "</div>"; }
            html += '<div style="margin-top:20px;border-top:2px solid #e0e0e0;padding-top:20px;"><h4 style="margin:0 0 15px 0;color:#183D3D;font-size:0.9rem;font-weight:600;">FC Configuration</h4><div class="fcr-setting-item" style="flex-direction:column;gap:8px;">';
            html += `<div style="width:100%;"><label class="fcr-fc-label">FC List (comma separated):</label><input type="text" id="fcr-fc-list-input" class="fcr-fc-input" value="${CONFIG.warehouses.list.join(", ")}" placeholder="RMU1, ZAZ1, CDG7"></div>`;
            html += `<div style="width:100%;"><label class="fcr-fc-label">Default FC:</label><input type="text" id="fcr-fc-default-input" class="fcr-fc-input" value="${CONFIG.warehouses.default}" placeholder="RMU1"></div>`;
            html += '<button id="fcr-fc-save-btn" class="fcr-fc-save-btn">Save FC Configuration</button></div></div>';
            this.container = $(`<div id="fcr-settings-menu" style="position:absolute;top:calc(100% + 10px);right:0;width:480px;max-height:520px;background:white;border:2px solid #183D3D;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.3);z-index:99998;display:none;overflow:hidden;"><div style="background:linear-gradient(135deg,#183D3D 0%,#2C5D5D 100%);color:white;padding:16px 20px;font-weight:600;display:flex;align-items:center;justify-content:space-between;"><span>FCResearch+ Settings</span><span style="font-size:0.75rem;opacity:0.8;">v${window.FCRPlusVersion}</span></div><div id="fcr-settings-content" style="padding:20px;max-height:420px;overflow-y:auto;overflow-x:hidden;">${html}</div></div>`);
            const cc = $("#fcr-controls-container"); if (cc.length) cc.append(this.container);
            this.container.find(".fcr-switch input").on("change", e => { const f = $(e.target).data("feature"); const en = e.target.checked; $.cookie(`cfg-${f}`, en ? "1" : "0"); SafeExecute.toast(`${CONFIG.features[f].label} ${en ? "enabled" : "disabled"}`); this.handleFeatureToggle(f, en); });
            this.container.find("#fcr-fc-save-btn").on("click", () => this.saveFCConfig());
            $(document).on("click", e => { if (!$(e.target).closest("#fcr-settings-menu, #fcr-settings-toggle").length && this.isOpen) this.close(); });
        },
        generateSettingHtml(key, config) { const en = Utils.isFeatureEnabled(key); return `<div class="fcr-setting-item"><label class="fcr-switch"><input type="checkbox" data-feature="${key}" ${en ? "checked" : ""}><span class="fcr-slider"></span></label><div class="fcr-setting-info"><div class="fcr-setting-label">${config.label}</div><div class="fcr-setting-desc">${config.description}</div></div></div>`; },
        saveFCConfig() {
            const listInput = document.getElementById("fcr-fc-list-input"); const defaultInput = document.getElementById("fcr-fc-default-input"); if (!listInput || !defaultInput) return;
            const rawList = listInput.value.toUpperCase().split(",").map(s => s.trim()).filter(s => s.length > 0); const defaultFC = defaultInput.value.toUpperCase().trim(); const fcPattern = /^[A-Z0-9]{3,4}$/;
            if (rawList.length === 0) { SafeExecute.toast("FC list cannot be empty", "error"); return; }
            const invalid = rawList.filter(fc => !fcPattern.test(fc)); if (invalid.length > 0) { SafeExecute.toast(`Invalid FC: ${invalid.join(", ")}`, "error"); return; }
            if (!fcPattern.test(defaultFC)) { SafeExecute.toast("Invalid default FC format", "error"); return; }
            if (!rawList.includes(defaultFC)) { SafeExecute.toast("Default FC must be in the list", "error"); return; }
            GM_setValue("userFCList", JSON.stringify(rawList)); GM_setValue("userDefaultFC", defaultFC);
            CONFIG.warehouses.list = rawList; CONFIG.warehouses.default = defaultFC;
            $("#fc-selector-container").remove(); UI.createFCSelector(); SafeExecute.toast("FC configuration saved");
        },
        handleFeatureToggle(feature, enabled) {
            setTimeout(() => {
                switch (feature) {
                    case "quickPrintBar": { const pb = $("#printmonContainer"); if (enabled) { if (pb.length) pb.css("visibility", "visible"); else UI.createPrintmonBar(); } else { if (pb.length) pb.css("visibility", "hidden"); } break; }
                    case "fcSelector": { const fs = $("#fc-selector-container .fc-button"); if (enabled) { if (fs.length) fs.css("visibility", "visible"); else UI.createFCSelector(); } else { if (fs.length) fs.css("visibility", "hidden"); } break; }
                    case "darkMode": Styles.apply(); break;
                    case "floorInfo": if (enabled) FloorInfo.attachButton(); else { FloorInfo.stopScanner(); $(".ff-btn-container, .ff-col-header, .ff-col").remove(); FloorInfo.floorVisible = false; FloorInfo.floorLoaded = false; } break;
                    case "hazmatInfo": if (enabled) HazmatIntegration.init(); else $(".hazmat-row").remove(); break;
                    case "prepInfo": if (enabled) PrepInstructionIntegration.init(); else $(".prep-row").remove(); break;
                    case "boxRecInfo": if (enabled) BoxRecIntegration.init(); else $(".boxrec-row").remove(); break;
                    case "dataMatrixGenerator": if (enabled) { DataMatrixGenerator.initialized = false; DataMatrixGenerator.init(); } else { DataMatrixGenerator.closeModal(); DataMatrixGenerator.removeTriggerButton(); } break;
                    case "receiveHistoryFilters": if (enabled) ReceiveHistoryFilters.init(); else ReceiveHistoryFilters.reset(); break;
                }
            }, 100);
        },
        toggle() { if (this.isOpen) this.close(); else this.open(); },
        open() { if (!this.container) return; this.container.slideDown(200); this.isOpen = true; this.container.find(".fcr-switch input").each((i, input) => { input.checked = Utils.isFeatureEnabled($(input).data("feature")); }); },
        close() { if (!this.container) return; this.container.slideUp(200); this.isOpen = false; },
    };

    // ========================================
    // STYLES
    // ========================================
    const Styles = {
        base: `
h6{font-weight:700;text-transform:uppercase;font-size:0.75rem;line-height:1px;padding-bottom:1px;}.logo-fc,.logo-research{font-size:1.25rem;}.aui-nav-search{display:flex !important;align-items:center !important;gap:0.625rem !important;flex-wrap:nowrap !important;margin-top:0 !important;position:relative !important;justify-content:space-between !important;}
.hazmat-row{background-color:#f9f9f9;}.hazmat-row-label,.hazmat-row th{padding:10px;font-weight:bold;vertical-align:middle;}.hazmat-row-value,.hazmat-row td{padding:10px;font-weight:bold;vertical-align:middle;}.hazmat-loading{background:linear-gradient(90deg,#e8f5e9 25%,#c8e6c9 50%,#e8f5e9 75%) !important;background-size:200% 100% !important;animation:loading 1s infinite !important;color:#2e7d32 !important;}@keyframes loading{0%{background-position:200% 0;}100%{background-position:-200% 0;}}.hazmat-row-error{background-color:#ffcccc !important;color:#cc0000 !important;}@keyframes fadeIn{to{opacity:1;}}
.prep-row{background-color:#f9f9f9;}.prep-row-label,.prep-row th{font-weight:bold;vertical-align:middle;}.prep-row-value,.prep-row td{font-weight:bold;vertical-align:middle;}.prep-loading{background:linear-gradient(90deg,#e3f2fd 25%,#bbdefb 50%,#e3f2fd 75%) !important;background-size:200% 100% !important;animation:loading 1s infinite !important;color:#1565c0 !important;}.prep-has-items{background-color:#e8f5e9 !important;color:#2e7d32 !important;}.prep-no-items{background-color:#f0f0f0 !important;color:#555555 !important;}.prep-certified-no{background-color:#fff3e0 !important;color:#e65100 !important;}.prep-row-error{background-color:#ffcccc !important;color:#cc0000 !important;}
.boxrec-row{background-color:#f9f9f9;}.boxrec-row-label,.boxrec-row th{font-weight:bold;vertical-align:middle;}.boxrec-row-value,.boxrec-row td{font-weight:bold;vertical-align:middle;}.boxrec-loading{background:linear-gradient(90deg,#f3e5f5 25%,#e1bee7 50%,#f3e5f5 75%) !important;background-size:200% 100% !important;animation:loading 1s infinite !important;color:#6a1b9a !important;}.boxrec-has-items{background-color:#f3e5f5 !important;color:#6a1b9a !important;}.boxrec-no-items{background-color:#fff3e0 !important;color:#e65100 !important;}.boxrec-error{background-color:#ffcccc !important;color:#cc0000 !important;}
#csvExportButton{background:white;border-radius:999px;box-shadow:rgba(0,0,0,0.2) 0 0.625rem 1.25rem -0.625rem;color:#183D3D;cursor:pointer;font-family:inherit;font-size:0.75rem;font-weight:700;padding:0.25rem 0.625rem;margin-left:0.625rem;border:1px solid #183D3D;transition:all 0.3s ease;position:relative;z-index:100;}#csvExportButton:hover{background:#f0f0f0;transform:translateY(-1px);}
#printmonContainer{display:inline-flex;align-items:center;gap:0.3125rem;background-color:white;border:0;padding:0.25rem 0.5rem;border-radius:0.375rem;flex-shrink:0;position:relative;z-index:1000;order:-2;margin-right:auto;margin-top:-12px;}#printmonContainer label{font-weight:600;color:#183D3D;font-size:0.6875rem;margin:0;white-space:nowrap;}#printmonContainer input[type="text"],#printmonContainer input[type="number"]{background-color:white;color:#183D3D;border:1px solid #ddd;padding:0.1875rem 0.375rem;border-radius:0.1875rem;font-size:0.75rem;}#printmonContainer input[type="text"]{width:6.25rem;}#printmonContainer input[type="number"]{width:2.8125rem;}
#printmonShortcut{background-color:#183D3D;color:white;border:none;padding:0.25rem 0.625rem;cursor:pointer;border-radius:0.25rem;font-size:0.6875rem;font-weight:600;transition:background-color 0.3s;position:relative;z-index:1001;}#printmonShortcut:hover{background-color:#2C5D5D;}
#fc-selector-container{display:inline-flex;gap:0.3125rem;align-items:center;flex-shrink:0;position:relative;z-index:1000;order:10;margin-left:auto;margin-top:-12px;}.fc-button{padding:0.25rem 0.625rem;border:2px solid #183D3D;background:white;color:#183D3D;cursor:pointer;border-radius:0.3125rem;font-weight:600;font-size:0.6875rem;transition:all 0.3s ease;position:relative;z-index:1001;}.fc-button:hover{background:#f0f0f0;}.fc-button.active{background:#183D3D;color:white;}
#darkModeToggle{width:2rem;height:2rem;border-radius:50%;border:2px solid #183D3D;background:white;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:1rem;transition:all 0.3s ease;flex-shrink:0;position:relative;z-index:1001;}#darkModeToggle:hover{transform:scale(1.1);}
.rs-filter-buttons-container{display:inline-flex;gap:0.3125rem;align-items:center;margin-right:0.9375rem;vertical-align:middle;float:left;position:relative;z-index:100;}#table-inventory-history_filter .a-icon-search{display:none !important;}#table-inventory-history_filter{overflow:visible;padding-top:0.3125rem;padding-bottom:0.3125rem;}#table-inventory-history_filter label{float:right;display:inline-flex !important;align-items:center !important;gap:0.3125rem !important;}#table-inventory-history_filter button,#table-inventory-history_filter .a-button{position:relative;top:0.1875rem;z-index:101;}
.rs-filter-button{padding:0.3125rem 0.875rem;border:2px solid #183D3D;background:white;color:#183D3D;cursor:pointer;border-radius:0.3125rem;font-weight:700;font-size:0.8125rem;transition:all 0.3s ease;min-width:2.8125rem;position:relative;z-index:102;}.rs-filter-button:hover:not(:disabled){background:#f0f0f0;transform:translateY(-1px);}.rs-filter-button.active{background:#183D3D;color:white;box-shadow:0 0 0.625rem rgba(24,61,61,0.5);}.rs-filter-button:disabled{background:#e0e0e0;color:#999;border-color:#ccc;cursor:not-allowed;opacity:0.5;}
.rh-filter-buttons-container{display:inline-flex;gap:0.3125rem;align-items:center;margin-right:0.9375rem;vertical-align:middle;float:left;position:relative;z-index:100;height:100%;padding-top:0.25rem;}.rh-filter-button{padding:0.3125rem 0.625rem;border:2px solid #183D3D;background:white;color:#183D3D;cursor:pointer;border-radius:0.3125rem;font-weight:700;font-size:0.6875rem;transition:all 0.3s ease;min-width:2rem;position:relative;z-index:102;white-space:nowrap;}.rh-filter-button:hover:not(:disabled){background:#f0f0f0;transform:translateY(-1px);}.rh-filter-button.active{background:#183D3D;color:white;box-shadow:0 0 0.625rem rgba(24,61,61,0.5);}.rh-filter-button:disabled{background:#e0e0e0;color:#999;border-color:#ccc;cursor:not-allowed;opacity:0.5;}
#maxRangeButton,#todayButton,#flipsToSellableButton{font-size:0.75rem;font-weight:400;line-height:1.1875rem;position:relative;z-index:100;}.a-button:has(#maxRangeButton),.a-button:has(#todayButton),.a-button:has(#flipsToSellableButton){margin-left:0.625rem;}.a-button.flips-active{background:#28a745 !important;}.a-button.flips-active button{color:white !important;font-weight:700 !important;}#flipsToSellableButtonContainer{display:inline-flex !important;align-items:center !important;gap:0.5rem !important;}#flips-quantity-counter{display:none;padding:0.25rem 0.75rem;background:#28a745;color:white;border-radius:0.25rem;font-weight:700;font-size:0.875rem;white-space:nowrap;animation:pulse 2s ease-in-out infinite;box-shadow:0 2px 8px rgba(40,167,69,0.3);}@keyframes pulse{0%,100%{box-shadow:0 2px 8px rgba(40,167,69,0.3),0 0 0 0 rgba(40,167,69,0.7);}50%{box-shadow:0 2px 8px rgba(40,167,69,0.3),0 0 0 10px rgba(40,167,69,0);}}
.badgePhoto{display:none;position:fixed;background-color:#f37d15;border:2px solid #183D3D;padding:0.3125rem;z-index:10000;border-radius:0.3125rem;box-shadow:0 0.25rem 0.625rem rgba(0,0,0,0.3);}.badgePhoto img{width:6.25rem;height:auto;display:block;}
.custom-context-menu{background:white;border:1px solid #183D3D;border-radius:0.25rem;box-shadow:0 0.125rem 0.3125rem rgba(0,0,0,0.3);padding:0.5rem 0;min-width:9.375rem;max-width:15.625rem;z-index:10000;position:fixed;}.custom-context-menu .menu-item{color:#183D3D;cursor:pointer;padding:0.5rem 1rem;font-size:0.875rem;transition:background-color 0.2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.custom-context-menu .menu-item:hover{background-color:#f0f0f0;}.custom-context-menu hr{border:none;border-top:1px solid #ddd;margin:0.25rem 0;}
.barcode-modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:100000;}.barcode-content{background:white;padding:1.25rem;border-radius:0.3125rem;text-align:center;}.barcode-close{margin-top:0.625rem;padding:0.3125rem 0.9375rem;background:#183D3D;color:white;border:none;border-radius:0.1875rem;cursor:pointer;}.barcode-close:hover{background:#2C5D5D;}.asin-print-button{margin-left:0.625rem;padding:0.25rem 0.75rem;background:#183D3D;color:white;border:none;border-radius:0.25rem;font-size:0.75rem;font-weight:600;cursor:pointer;transition:all 0.3s ease;}.asin-print-button:hover{background:#2C5D5D;transform:translateY(-1px);box-shadow:0 2px 5px rgba(0,0,0,0.2);}
.asin-image-container{display:none;position:fixed;z-index:10000;background-color:white;padding:0.3125rem;border:1px solid #ccc;border-radius:0.3125rem;box-shadow:0 0.125rem 0.625rem rgba(0,0,0,0.2);}.asin-image-container img{max-width:12.5rem;max-height:12.5rem;}
.ff-btn-container{margin-bottom:0.625rem;display:flex;align-items:center;gap:10px;}.ff-btn{background-color:#183D3D;color:white;border:none;padding:0.5rem 1rem;cursor:pointer;border-radius:0.25rem;font-size:0.8125rem;font-weight:600;transition:all 0.3s ease;position:relative;z-index:100;}.ff-btn:hover{background-color:#2C5D5D;transform:translateY(-1px);box-shadow:0 0.125rem 0.3125rem rgba(0,0,0,0.2);}.ff-btn.active{background-color:#28a745;}.ff-btn.active:hover{background-color:#218838;}
.ff-col-header{text-align:center !important;font-weight:700 !important;min-width:80px;}.ff-col{text-align:center;vertical-align:middle;font-weight:600;}.ff-ok{color:#28a745;font-weight:700;font-size:0.8125rem;}.ff-error{color:#dc3545;font-weight:600;font-size:0.75rem;}.ff-loading{color:#999;font-weight:600;font-size:0.75rem;animation:ff-pulse 1s ease-in-out infinite;}
@keyframes ff-pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}
@keyframes slideIn{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}
#dmx-trigger{position:fixed;bottom:20px;right:20px;width:48px;height:48px;border-radius:50%;background:#183D3D;color:white;border:none;font-size:20px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:99999;display:flex;align-items:center;justify-content:center;transition:all 0.3s ease;}#dmx-trigger:hover{transform:scale(1.1);background:#2C5D5D;}#dmx-backdrop{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:100000;display:flex;align-items:center;justify-content:center;}#dmx-modal{background:white;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);max-width:1200px;width:95%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;}#dmx-header{background:linear-gradient(135deg,#183D3D,#2C5D5D);color:white;padding:16px 20px;font-weight:600;font-size:1rem;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;}#dmx-close{background:none;border:none;color:white;font-size:1.5rem;cursor:pointer;padding:0;line-height:1;opacity:0.8;transition:opacity 0.2s;}#dmx-close:hover{opacity:1;}#dmx-body{padding:20px;overflow-y:auto;flex:1;}#dmx-textarea{width:100%;height:120px;border:2px solid #ddd;border-radius:8px;padding:10px;font-family:monospace;font-size:0.875rem;resize:vertical;box-sizing:border-box;transition:border-color 0.3s;}#dmx-textarea:focus{outline:none;border-color:#183D3D;}#dmx-textarea::placeholder{color:#aaa;}#dmx-hint{font-size:0.75rem;color:#888;margin:8px 0 16px 0;}#dmx-actions{display:flex;gap:10px;}#dmx-generate{flex:1;padding:10px;background:#183D3D;color:white;border:none;border-radius:8px;font-weight:600;font-size:0.875rem;cursor:pointer;transition:all 0.3s;}#dmx-generate:hover{background:#2C5D5D;}#dmx-generate:disabled{background:#ccc;cursor:not-allowed;opacity:0.7;}#dmx-clear{padding:10px 16px;background:white;color:#666;border:2px solid #ddd;border-radius:8px;font-size:0.875rem;cursor:pointer;transition:all 0.2s;}#dmx-clear:hover{border-color:#999;color:#333;}#dmx-error{color:#dc3545;font-size:0.8rem;font-weight:600;margin-top:8px;display:none;}#dmx-history{margin-top:16px;border-top:1px solid #eee;padding-top:12px;}#dmx-history-toggle{display:flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;padding:4px 0;font-size:0.8rem;font-weight:600;color:#666;width:100%;transition:color 0.2s;}#dmx-history-toggle:hover{color:#183D3D;}#dmx-history-arrow{display:inline-block;transition:transform 0.2s ease;font-size:0.6rem;}#dmx-history-arrow.open{transform:rotate(90deg);}#dmx-history-badge{background:#183D3D;color:white;font-size:0.6rem;font-weight:700;padding:1px 6px;border-radius:10px;margin-left:4px;}#dmx-history-content{overflow:hidden;max-height:0;transition:max-height 0.3s ease;}#dmx-history-content.open{max-height:500px;}#dmx-history-actions{display:flex;justify-content:flex-end;margin:8px 0 6px 0;}#dmx-history-clear{font-size:0.7rem;color:#999;background:none;border:none;cursor:pointer;padding:2px 6px;border-radius:4px;transition:all 0.2s;}#dmx-history-clear:hover{color:#dc3545;background:#fff0f0;}#dmx-history-list{display:flex;flex-direction:column;gap:6px;}.dmx-history-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e8e8e8;border-radius:6px;cursor:pointer;transition:all 0.2s;background:#fafafa;}.dmx-history-item:hover{border-color:#183D3D;background:#f0f7f7;}.dmx-history-count{background:#183D3D;color:white;font-size:0.7rem;font-weight:700;padding:2px 7px;border-radius:10px;flex-shrink:0;}.dmx-history-bins{font-family:monospace;font-size:0.75rem;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;}.dmx-history-date{font-size:0.65rem;color:#aaa;flex-shrink:0;white-space:nowrap;}#dmx-history-empty{font-size:0.75rem;color:#bbb;text-align:center;padding:8px;font-style:italic;}#dmx-grid-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-shrink:0;}#dmx-grid-count{font-size:0.85rem;color:#666;font-weight:600;}#dmx-back{padding:6px 14px;background:none;border:1px solid #ccc;border-radius:6px;color:#666;font-size:0.8rem;cursor:pointer;transition:all 0.2s;}#dmx-back:hover{border-color:#999;color:#333;}#dmx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:24px;}.dmx-card{display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 8px;border:2px solid #e0e0e0;border-radius:10px;background:#fafafa;transition:all 0.2s;}.dmx-card:hover{border-color:#183D3D;box-shadow:0 2px 8px rgba(24,61,61,0.15);}.dmx-card-label{font-family:monospace;font-size:0.75rem;font-weight:700;color:#183D3D;text-align:center;word-break:break-all;line-height:1.3;}.dmx-card canvas{image-rendering:pixelated;}.dmx-card-error{color:#dc3545;font-size:0.7rem;font-weight:600;padding:10px;text-align:center;}#dmx-print{padding:6px 14px;background:#183D3D;color:white;border:none;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer;transition:background 0.3s;}#dmx-print:hover{background:#2C5D5D;}
#dmx-floor-filters{margin-bottom:12px;min-height:24px;}.dmx-floor-buttons{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}.dmx-floor-btn{padding:4px 12px;border:2px solid #183D3D;background:white;color:#183D3D;cursor:pointer;border-radius:20px;font-weight:600;font-size:0.75rem;transition:all 0.2s ease;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}.dmx-floor-btn:hover{background:#f0f7f7;transform:translateY(-1px);}.dmx-floor-btn.active{background:#183D3D;color:white;box-shadow:0 2px 8px rgba(24,61,61,0.3);}.dmx-floor-btn-count{font-size:0.65rem;background:rgba(24,61,61,0.15);padding:1px 6px;border-radius:10px;font-weight:700;}.dmx-floor-btn.active .dmx-floor-btn-count{background:rgba(255,255,255,0.25);}.dmx-floor-loading{font-size:0.75rem;color:#999;font-style:italic;display:inline-block;margin-left:8px;}
@media print{body>*:not(#dmx-backdrop){display:none !important;}#dmx-backdrop{position:static !important;background:none !important;}#dmx-modal{max-width:100% !important;max-height:none !important;box-shadow:none !important;border:none !important;}#dmx-header,#dmx-grid-header,#dmx-back,#dmx-print,#dmx-floor-filters{display:none !important;}#dmx-body{overflow:visible !important;}#dmx-grid{grid-template-columns:repeat(5,1fr) !important;gap:8px !important;}.dmx-card{break-inside:avoid;border:1px solid #ccc !important;padding:8px 4px !important;}}@media (max-width:700px){#dmx-grid{grid-template-columns:repeat(2,1fr);}}@media (min-width:701px) and (max-width:950px){#dmx-grid{grid-template-columns:repeat(3,1fr);}}
`,
        dark: `
body,.a-cal-labels,.a-popover-inner{background-color:#1a1a1a;color:#e5e5e5;}table.a-bordered tr:nth-child(2n+1),table.a-bordered tr.odd td{background-color:#2d2d2d !important;}table.a-bordered tr:nth-child(2n),table.a-bordered tr.even td{background-color:#242424 !important;}table.a-bordered td,table.a-bordered th,table.a-bordered,table.a-bordered tr:last-child td{border-color:#404040;color:#e5e5e5;}table.a-bordered tr:first-child th{background:#333333;color:#e5e5e5;border-color:#404040;}.a-box,.a-cal-na,table.a-keyvalue th,.a-box-title .a-box-inner,.a-popover-header,.aui-nav-row,a.a-link-section-expander,.a-expander-content{background-color:#2d2d2d;border-color:#404040;color:#e5e5e5;}.a-box{border-top-color:#404040 !important;}table.a-keyvalue td,table.a-keyvalue th,table.a-keyvalue{border-color:#404040;}.a-keyvalue th{background-color:#3a3a3a !important;color:#e5e5e5 !important;}.a-box-title .a-box-inner,.a-popover-header,.aui-nav-row{background:linear-gradient(to bottom,#2d2d2d,#333333);}h6,.p,.a-popover-inner,body a,.a-nostyle,.a-nostyle span,.logo-fc,.logo-research{color:#e5e5e5 !important;}.a-search input{color:#e5e5e5;background-color:#2d2d2d !important;border:1px solid #404040;}a.a-link-section-expander:hover,a.a-link-section-expander:focus{background-color:#3a3a3a;}.a-section-expander-inner{border-top:1px solid #404040;}
.hazmat-row{background-color:#2d2d2d !important;}.hazmat-row-label,.hazmat-row th{color:#e5e5e5 !important;}.hazmat-loading{background:linear-gradient(90deg,#1a3a1a 25%,#2a4a2a 50%,#1a3a1a 75%) !important;background-size:200% 100% !important;color:#4ade80 !important;}
.prep-row{background-color:#2d2d2d !important;}.prep-row-label,.prep-row th{color:#e5e5e5 !important;}.prep-loading{background:linear-gradient(90deg,#1a2a3a 25%,#2a3a4a 50%,#1a2a3a 75%) !important;background-size:200% 100% !important;color:#60a5fa !important;}.prep-has-items{background-color:#1a3a1a !important;color:#4ade80 !important;}.prep-no-items{background-color:#2d2d2d !important;color:#999999 !important;}.prep-certified-no{background-color:#3a2a1a !important;color:#fbbf24 !important;}.prep-row-error{background-color:#3a1a1a !important;color:#f87171 !important;}
.boxrec-row{background-color:#2d2d2d !important;}.boxrec-row-label,.boxrec-row th{color:#e5e5e5 !important;}.boxrec-loading{background:linear-gradient(90deg,#2a1a3a 25%,#3a2a4a 50%,#2a1a3a 75%) !important;background-size:200% 100% !important;color:#c084fc !important;}.boxrec-has-items{background-color:#2a1a3a !important;color:#c084fc !important;}.boxrec-no-items{background-color:#3a2a1a !important;color:#fbbf24 !important;}.boxrec-error{background-color:#3a1a1a !important;color:#f87171 !important;}
#csvExportButton{background:#ff9900;box-shadow:rgba(255,153,0,0.3) 0 0.625rem 1.25rem -0.625rem;color:#1a1a1a;border:0;font-weight:700;}#csvExportButton:hover{background:#ffad33;}.asin-print-button{background:#ff9900;color:#1a1a1a;}.asin-print-button:hover{background:#ffad33;}
#printmonContainer{background-color:#2d2d2d;border-color:#404040;}#printmonContainer label{color:#e5e5e5;}#printmonContainer input[type="text"],#printmonContainer input[type="number"]{background-color:#1a1a1a;color:#e5e5e5;border-color:#404040;}#printmonShortcut{background-color:#ff9900;color:#1a1a1a;}#printmonShortcut:hover{background-color:#ffad33;}#fc-selector-container{background:transparent;border:none;}.fc-button{background:#2d2d2d;color:#e5e5e5;border-color:#404040;}.fc-button:hover{background:#3a3a3a;border-color:#ff9900;}.fc-button.active{background:#ff9900;color:#1a1a1a;border-color:#ff9900;}#darkModeToggle,#fcr-settings-toggle{background:#2d2d2d;border:2px solid #404040;color:#e5e5e5;}#darkModeToggle:hover,#fcr-settings-toggle:hover{background:#3a3a3a;border-color:#ff9900;}.rs-filter-button{background:#2d2d2d;color:#e5e5e5;border-color:#404040;}.rs-filter-button:hover:not(:disabled){background:#3a3a3a;border-color:#ff9900;}.rs-filter-button.active{background:#ff9900;color:#1a1a1a;border-color:#ff9900;}.rs-filter-button:disabled{background:#1a1a1a;color:#666666;border-color:#333333;}.rh-filter-button{background:#2d2d2d;color:#e5e5e5;border-color:#404040;}.rh-filter-button:hover:not(:disabled){background:#3a3a3a;border-color:#ff9900;}.rh-filter-button.active{background:#ff9900;color:#1a1a1a;border-color:#ff9900;}.rh-filter-button:disabled{background:#1a1a1a;color:#666666;border-color:#333333;}
#flips-quantity-counter{background:#4ade80 !important;color:#1a1a1a !important;}.custom-context-menu{background:#2d2d2d;border:1px solid #404040;box-shadow:0 0.25rem 0.625rem rgba(0,0,0,0.5);}.custom-context-menu .menu-item{color:#e5e5e5;}.custom-context-menu .menu-item:hover{background-color:#3a3a3a;}.custom-context-menu hr{border-top:1px solid #404040;}.barcode-content{background:#2d2d2d;color:#e5e5e5;}.barcode-close{background:#ff9900;color:#1a1a1a;}.barcode-close:hover{background:#ffad33;}.asin-image-container{background-color:#2d2d2d;border:1px solid #404040;}
.ff-btn{background:#ff9900;color:#1a1a1a;}.ff-btn:hover{background:#ffad33;}.ff-btn.active{background-color:#4ade80;color:#1a1a1a;}.ff-btn.active:hover{background-color:#22c55e;}.ff-ok{color:#4ade80;}.ff-error{color:#f87171;}.ff-loading{color:#666;}
.badgePhoto{background-color:#2d2d2d;border:2px solid #ff9900;}.a-button.flips-active{background:#4ade80 !important;}#fcr-settings-menu{background:#2d2d2d !important;border-color:#404040 !important;}#fcr-settings-menu>div:first-child{background:linear-gradient(135deg,#ff9900 0%,#ffad33 100%) !important;color:#1a1a1a !important;}.fcr-setting-label{color:#ff9900 !important;}.fcr-setting-desc{color:#b3b3b3 !important;}.fcr-setting-item:hover{background:rgba(255,153,0,0.1) !important;}
#dmx-trigger{background:#ff9900;color:#1a1a1a;}#dmx-trigger:hover{background:#ffad33;}#dmx-modal{background:#2d2d2d;}#dmx-header{background:linear-gradient(135deg,#ff9900 0%,#ffad33 100%) !important;color:#1a1a1a !important;}#dmx-close{color:#1a1a1a !important;}#dmx-body{background:#2d2d2d;}#dmx-textarea{background:#1a1a1a;color:#e5e5e5;border-color:#404040;}#dmx-textarea:focus{border-color:#ff9900;}#dmx-textarea::placeholder{color:#666;}#dmx-hint{color:#999;}#dmx-generate{background:#ff9900;color:#1a1a1a;}#dmx-generate:hover{background:#ffad33;}#dmx-generate:disabled{background:#404040;color:#666;}#dmx-clear{background:#2d2d2d;color:#999;border-color:#404040;}#dmx-clear:hover{border-color:#666;color:#e5e5e5;}#dmx-error{color:#f87171;}#dmx-history{border-top-color:#404040;}#dmx-history-toggle{color:#999;}#dmx-history-toggle:hover{color:#ff9900;}#dmx-history-badge{background:#ff9900;color:#1a1a1a;}#dmx-history-clear:hover{color:#f87171;background:#3a1a1a;}.dmx-history-item{background:#1a1a1a;border-color:#404040;}.dmx-history-item:hover{border-color:#ff9900;background:#333;}.dmx-history-count{background:#ff9900;color:#1a1a1a;}.dmx-history-bins{color:#e5e5e5;}.dmx-history-date{color:#666;}#dmx-history-empty{color:#666;}#dmx-grid-count{color:#999;}#dmx-back{border-color:#404040;color:#999;}#dmx-back:hover{border-color:#666;color:#e5e5e5;}.dmx-card{background:#1a1a1a;border-color:#404040;}.dmx-card:hover{border-color:#ff9900;box-shadow:0 2px 8px rgba(255,153,0,0.15);}.dmx-card-label{color:#ff9900;}.dmx-card-error{color:#f87171;}#dmx-print{background:#ff9900;color:#1a1a1a;}#dmx-print:hover{background:#ffad33;}
.dmx-floor-btn{background:#1a1a1a;color:#e5e5e5;border-color:#404040;}.dmx-floor-btn:hover{background:#333;border-color:#ff9900;}.dmx-floor-btn.active{background:#ff9900;color:#1a1a1a;border-color:#ff9900;}.dmx-floor-btn-count{background:rgba(255,255,255,0.1);}.dmx-floor-btn.active .dmx-floor-btn-count{background:rgba(0,0,0,0.2);}.dmx-floor-loading{color:#666;}
`,
        apply() { GM_addStyle(this.base); const dms = document.getElementById("dark-mode-style"); if (Utils.isFeatureEnabled("darkMode")) { if (!dms) $("<style id='dark-mode-style'></style>").text(this.dark).appendTo($("body")); $("#darkModeToggle").text("☀️"); } else { if (dms) dms.remove(); $("#darkModeToggle").text("🌙"); } },
    };

    // ========================================
    // UI COMPONENTS
    // ========================================
    const UI = {
        async createPrintmonBar() {
            if (!Utils.isFeatureEnabled("quickPrintBar")) return;
            const sb = await Utils.waitForElement(".aui-nav-search").catch(() => null); if (!sb || document.getElementById("printmonContainer")) return;
            const c = $(`<div id="printmonContainer"><label>Quick Print:</label><input type="text" id="barcodeSearchText" placeholder="Barcode/ASIN" autocomplete="off"><input type="number" id="barcodeSearchQuantity" value="1" min="1"><button id="printmonShortcut">Print</button></div>`);
            const hp = async () => {
                const text = $("#barcodeSearchText").val().trim(); const qty = $("#barcodeSearchQuantity").val();
                if (!text) { SafeExecute.toast("Enter a barcode or ASIN", "error"); return; }
                const badge = $.cookie("fcmenu-employeeId") || "";
                const asinMatch = text.match(/\b(B0|X0)[A-Z0-9]{8}\b/);
                if (asinMatch) { const asin = asinMatch[0]; $("#printmonShortcut").text("...").prop("disabled", true); try { let title = AsinTitle.getFromPage(asin); if (!title) title = await AsinTitle.fetch(asin); Printer.send(asin, qty, badge, title || "No Title Found"); } catch (e) { Printer.send(asin, qty, badge, "No Title Found"); } $("#printmonShortcut").text("Print").prop("disabled", false); }
                else { Printer.send(text, qty, badge, ""); }
                $("#barcodeSearchText").val("").focus();
            };
            c.find("#printmonShortcut").on("click", hp);
            c.find("#barcodeSearchText").on("keypress", e => { if (e.key === "Enter") { e.preventDefault(); hp(); } });
            $(sb).prepend(c);
        },
        async createFCSelector() {
            if (!Utils.isFeatureEnabled("fcSelector")) return;
            const sb = await Utils.waitForElement(".aui-nav-search").catch(() => null); if (!sb || document.getElementById("fc-selector-container")) return;
            const c = $('<div id="fc-selector-container"></div>');
            CONFIG.warehouses.list.forEach(fc => {
                const b = $(`<button class="fc-button ${fc === STATE.currentFC ? "active" : ""}">${fc}</button>`);
                b.on("click", () => { GM_setValue("selectedFC", fc); const cs = new URLSearchParams(window.location.search).get("s") || ""; window.location.href = `${CONFIG.endpoints.base}/${fc}/results${cs ? "?s=" + cs : ""}`; });
                c.append(b);
            });
            $(sb).append(c);
        },
        async createControlsContainer() { const sb = await Utils.waitForElement(".aui-nav-search").catch(() => null); if (!sb || document.getElementById("fcr-controls-container")) return; $(sb).append($(`<div id="fcr-controls-container" style="display:inline-flex;gap:0.3125rem;align-items:center;flex-shrink:0;position:relative;z-index:1002;order:12;margin-top:-12px;"></div>`)); },
        async createDarkModeToggle() {
            const cc = await Utils.waitForElement("#fcr-controls-container").catch(() => null); if (!cc || document.getElementById("darkModeToggle")) return;
            const toggle = $('<button id="darkModeToggle">🌙</button>');
            toggle.on("click", () => { const ns = $.cookie("cfg-darkMode") === "1" ? "0" : "1"; $.cookie("cfg-darkMode", ns); Styles.apply(); SafeExecute.toast(`Dark mode ${ns === "1" ? "enabled" : "disabled"}`); });
            $(cc).append(toggle); Styles.apply(); SettingsMenu.createButton();
        },
        createRSFilterButtons() {
            const sfd = document.getElementById("table-inventory-history_filter"); if (!sfd || sfd.querySelector(".rs-filter-buttons-container")) return;
            const si = sfd.querySelector(".a-icon-search"); if (si) si.style.display = "none";
            const rfr = document.querySelector('tr[data-col="inventory-history-rs"]');
            let av = new Set(CONFIG.rsValues);
            if (rfr) { const sel = rfr.querySelector("select.a-input-text"); if (sel) { av.clear(); sel.querySelectorAll("option").forEach(o => { const v = o.textContent.trim(); if (v && CONFIG.rsValues.includes(v)) av.add(v); }); } }
            const bc = document.createElement("div"); bc.className = "rs-filter-buttons-container";
            CONFIG.rsValues.forEach(value => {
                const btn = document.createElement("button"); btn.className = "rs-filter-button"; btn.textContent = value; btn.dataset.rsValue = value;
                if (!av.has(value)) btn.disabled = true;
                btn.addEventListener("click", function (e) {
                    e.preventDefault(); e.stopPropagation();
                    const cv = this.dataset.rsValue; const rf = document.querySelector('tr[data-col="inventory-history-rs"]');
                    if (!rf) { alert("Open the advanced filters (+) first"); return; }
                    const sel = rf.querySelector("select.a-input-text"); if (!sel) return;
                    if (STATE.activeRSFilter === cv) { STATE.setRSFilter(null); sel.value = ""; this.classList.remove("active"); }
                    else { STATE.setRSFilter(cv); sel.value = cv; bc.querySelectorAll(".rs-filter-button").forEach(b => b.classList.remove("active")); this.classList.add("active"); }
                    sel.dispatchEvent(new Event("change", { bubbles: true }));
                });
                bc.appendChild(btn);
            });
            sfd.insertBefore(bc, sfd.firstChild);
            new MutationObserver(() => { const rf = document.querySelector('tr[data-col="inventory-history-rs"]'); if (!rf) return; const sel = rf.querySelector("select.a-input-text"); if (!sel) return; const sv = sel.value; bc.querySelectorAll(".rs-filter-button").forEach(b => { if (b.dataset.rsValue === sv && sv !== "") { b.classList.add("active"); STATE.setRSFilter(sv); } else { b.classList.remove("active"); if (sv === "") STATE.setRSFilter(null); } }); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["value"] });
        },
        createMaxRangeButton() {
            const sbc = document.querySelector('span[data-action="inventory-history-search-button"]'); if (!sbc || document.getElementById("maxRangeButtonContainer")) return;
            const p = sbc.parentElement; if (!p) return;
            const w = document.createElement("span"); w.id = "maxRangeButtonContainer"; w.className = "a-declarative"; w.style.marginLeft = "0.625rem";
            const bw = document.createElement("span"); bw.className = "a-button a-button-base"; const bi = document.createElement("span"); bi.className = "a-button-inner";
            const btn = document.createElement("button"); btn.id = "maxRangeButton"; btn.className = "a-button-text"; btn.type = "button"; btn.textContent = "Max Range";
            btn.addEventListener("click", e => {
                e.preventDefault(); e.stopPropagation();
                const d = new Date(); d.setMonth(d.getMonth() - 6);
                const fd = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
                const si = document.getElementById("searchStart"); if (!si) { alert("Date field not found"); return; }
                try { Utils.setDateInput(si, fd); setTimeout(() => { if (si.value !== fd) { si.value = fd; $(si).val(fd).trigger("change"); } setTimeout(() => { const sb = document.querySelector('span[data-action="inventory-history-search-button"] button'); if (sb) sb.click(); }, 200); }, 500); SafeExecute.toast("Date set to 6 months ago"); } catch (er) { alert("Error setting the date."); }
            });
            bi.appendChild(btn); bw.appendChild(bi); w.appendChild(bw); p.insertBefore(w, sbc.nextSibling);
        },
        createTodayButton() {
            const sbc = document.querySelector('span[data-action="inventory-history-search-button"]'); if (!sbc || document.getElementById("todayButtonContainer")) return;
            const p = sbc.parentElement; if (!p) return;
            const w = document.createElement("span"); w.id = "todayButtonContainer"; w.className = "a-declarative"; w.style.marginLeft = "0.625rem";
            const bw = document.createElement("span"); bw.className = "a-button a-button-base"; const bi = document.createElement("span"); bi.className = "a-button-inner";
            const btn = document.createElement("button"); btn.id = "todayButton"; btn.className = "a-button-text"; btn.type = "button"; btn.textContent = "Today";
            btn.addEventListener("click", e => {
                e.preventDefault(); e.stopPropagation();
                const t = new Date(); const fd = `${String(t.getMonth() + 1).padStart(2, "0")}/${String(t.getDate()).padStart(2, "0")}/${t.getFullYear()}`;
                const si = document.getElementById("searchStart"), ei = document.getElementById("searchEnd");
                if (!si || !ei) { alert("Date fields not found"); return; }
                try { Utils.setDateInput(si, fd); setTimeout(() => { Utils.setDateInput(ei, fd); setTimeout(() => { if (si.value !== fd) { si.value = fd; $(si).val(fd).trigger("change"); } if (ei.value !== fd) { ei.value = fd; $(ei).val(fd).trigger("change"); } setTimeout(() => { const sb = document.querySelector('span[data-action="inventory-history-search-button"] button'); if (sb) sb.click(); SafeExecute.toast("Dates set to today"); }, 200); }, 500); }, 300); } catch (er) { alert("Error setting the dates."); }
            });
            bi.appendChild(btn); bw.appendChild(bi); w.appendChild(bw);
            const mrb = document.getElementById("maxRangeButtonContainer"); if (mrb) p.insertBefore(w, mrb.nextSibling); else p.insertBefore(w, sbc.nextSibling);
        },
        createFlipsToSellableButton() { FlipsToSellable.createButton(); },
    };

    // ========================================
    // IMAGE HOVER
    // ========================================
    const ImageHover = {
        container: null, currentAsin: null, initialized: false,
        init() {
            if (!Utils.isFeatureEnabled("imageHover") || this.initialized) return;
            this.container = document.createElement("div"); this.container.className = "asin-image-container"; document.body.appendChild(this.container);
            $(document).on("mouseenter", "a", e => { const t = e.target.textContent.trim(); if (Validators.isValidASIN(t)) this.handleEnter(e, t); });
            $(document).on("mouseleave", "a", e => { const t = e.target.textContent.trim(); if (Validators.isValidASIN(t)) this.handleLeave(); });
            this.initialized = true;
        },
        handleEnter(event, asin) {
            if (this.currentAsin === asin && this.container.style.display === "block") return;
            this.currentAsin = asin; const rect = event.target.getBoundingClientRect();
            this.container.style.cssText = `display:block;position:fixed;top:${rect.top}px;left:${rect.right + 10}px;z-index:10000;background-color:white;padding:0.3125rem;border:1px solid #ccc;border-radius:0.3125rem;box-shadow:0 0.125rem 0.625rem rgba(0,0,0,0.2);`;
            const cr = this.container.getBoundingClientRect(); if (cr.right > window.innerWidth) this.container.style.left = `${rect.left - cr.width - 10}px`;
            const cu = imageCache.get(asin);
            if (cu) { if (cu === "NO_IMAGE") this.container.innerHTML = '<div style="padding:0.5rem;color:#666;font-size:0.75rem;">No image available</div>'; else { const img = document.createElement("img"); img.src = cu; img.style.maxWidth = img.style.maxHeight = "12.5rem"; this.container.innerHTML = ""; this.container.appendChild(img); } return; }
            this.container.innerHTML = '<div style="padding:1.5rem;text-align:center;"><div style="border:3px solid #f3f3f3;border-top:3px solid #ff9900;border-radius:50%;width:2rem;height:2rem;animation:spin 1s linear infinite;margin:0 auto;"></div><div style="margin-top:0.5rem;color:#666;font-size:0.75rem;">Loading...</div></div>';
            this.fetchImage(asin);
        },
        fetchImage(asin) {
            const wid = $.cookie("fcmenu-warehouseId") || STATE.currentFC;
            GM_xmlhttpRequest({
                method: "POST", url: `${CONFIG.endpoints.base}/${wid}/results/product`, data: `s=${asin}`,
                headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: CONFIG.performance.timeout,
                onload: r => {
                    try {
                        const doc = domParser.parseFromString(r.responseText, "text/html");
                        const img = doc.querySelector("img, .product-image, [data-image]");
                        if (img?.src) {
                            const src = img.src.replace(/^http:/, "https:").replace(/https?:\/\/ecx\.images-amazon\.com/, "https://images-na.ssl-images-amazon.com").replace(/https?:\/\/m\.media-amazon\.com/, "https://m.media-amazon.com");
                            imageCache.set(asin, src);
                            if (this.container.style.display !== "none" && this.currentAsin === asin) { const pi = document.createElement("img"); pi.src = src; pi.style.maxWidth = pi.style.maxHeight = "12.5rem"; pi.onerror = () => { imageCache.set(asin, "NO_IMAGE"); this.container.innerHTML = '<div style="padding:0.5rem;color:#666;font-size:0.75rem;">Image unavailable</div>'; }; this.container.innerHTML = ""; this.container.appendChild(pi); }
                        } else { imageCache.set(asin, "NO_IMAGE"); if (this.container.style.display !== "none" && this.currentAsin === asin) this.container.innerHTML = '<div style="padding:0.5rem;color:#666;font-size:0.75rem;">No image available</div>'; }
                    } catch (e) { imageCache.set(asin, "NO_IMAGE"); if (this.container.style.display !== "none" && this.currentAsin === asin) this.container.innerHTML = '<div style="padding:0.5rem;color:#666;font-size:0.75rem;">Error loading</div>'; }
                },
                onerror: () => { imageCache.set(asin, "NO_IMAGE"); if (this.container.style.display !== "none" && this.currentAsin === asin) this.container.innerHTML = '<div style="padding:0.5rem;color:#666;font-size:0.75rem;">Error loading image</div>'; }
            });
        },
        handleLeave() { this.container.style.display = "none"; this.currentAsin = null; },
    };

    // ========================================
    // BADGE PHOTOS
    // ========================================
    const BadgePhotos = {
        container: null, currentLogin: null, initialized: false,
        init() {
            if (!Utils.isFeatureEnabled("badgePhotos") || this.initialized) return;
            if (!document.getElementById("badgePhotoContainer")) { this.container = document.createElement("div"); this.container.id = "badgePhotoContainer"; this.container.className = "badgePhoto"; document.body.appendChild(this.container); } else this.container = document.getElementById("badgePhotoContainer");
            const sels = ["#table-problems td:nth-child(6)", "#table-inventory-history td:nth-child(9)", "#table-receive-history_wrapper td:nth-child(2)", "#table-container-history td:nth-child(3)"].join(", ");
            $(document).on("mouseenter", sels, e => { const ln = $(e.target).text().trim(); if (Validators.isValidLogin(ln)) this.handleEnter(e, ln); });
            $(document).on("mouseleave", sels, () => this.handleLeave()); this.initialized = true;
        },
        handleEnter(event, loginName) {
            if (this.currentLogin === loginName && this.container.style.display === "block") return;
            this.currentLogin = loginName; const rect = event.target.getBoundingClientRect();
            let pT = rect.top, pL = rect.right + 10;
            if (pL + 120 > window.innerWidth) pL = rect.left - 130; if (pT + 120 > window.innerHeight) pT = window.innerHeight - 130;
            if (pT < 0) pT = 10; if (pL < 0) pL = rect.right + 10;
            this.container.style.cssText = `display:block;position:fixed;top:${pT}px;left:${pL}px;z-index:10000;background-color:#f37d15;border:2px solid #183D3D;padding:0.3125rem;border-radius:0.3125rem;box-shadow:0 0.25rem 0.625rem rgba(0,0,0,0.3);`;
            const img = document.createElement("img"); img.src = `${CONFIG.endpoints.badgePhotos}/?uid=${loginName}`;
            img.style.cssText = "width:6.25rem;height:auto;display:block;";
            img.onerror = () => { this.container.innerHTML = '<div style="padding:0.625rem;color:white;font-size:0.75rem;text-align:center;">No photo<br>available</div>'; };
            this.container.innerHTML = ""; this.container.appendChild(img);
        },
        handleLeave() { this.container.style.display = "none"; this.currentLogin = null; },
    };

    // ========================================
    // FEATURES
    // ========================================
    const Features = {
        addCSVExportButton() {
            const ih = document.querySelector('[data-section-type="inventory"] .section-title'); if (!ih || document.getElementById("csvExportButton")) return;
            const btn = document.createElement("button"); btn.id = "csvExportButton"; btn.textContent = "Export to CSV";
            btn.addEventListener("click", () => {
                SafeExecute.run(() => {
                    const table = document.querySelector("#table-inventory"); if (!table) { alert("No inventory table found"); return; }
                    const csv = [], headers = [];
                    document.querySelector("#table-inventory_wrapper .dataTables_scrollHead thead tr").querySelectorAll("th").forEach(th => headers.push(th.textContent.trim().replace(/\n/g, " ")));
                    csv.push(headers.join(","));
                    table.querySelector("tbody").querySelectorAll("tr").forEach(row => { const rd = []; row.querySelectorAll("td").forEach(td => { let t = td.textContent.trim().replace(/\s+/g, " ").replace(/"/g, '""'); if (t.includes(",") || t.includes('"') || t.includes("\n")) t = `"${t}"`; rd.push(t); }); csv.push(rd.join(",")); });
                    const blob = new Blob([csv.join("\n")], { type: "text/csv;charset=utf-8;" });
                    const link = document.createElement("a"); const ts = new Date().toISOString().replace(/[:. ]/g, "-").slice(0, -5);
                    const fc = window.location.pathname.match(/\/([A-Z0-9]{3,4})\//)?.[1] || "unknown";
                    link.setAttribute("href", URL.createObjectURL(blob)); link.setAttribute("download", `inventory_${fc}_${ts}.csv`);
                    link.style.visibility = "hidden"; document.body.appendChild(link); link.click(); document.body.removeChild(link);
                    SafeExecute.toast("CSV exported successfully");
                }, "CSV Export", true);
            });
            ih.appendChild(btn);
        },
        // [OPT 1.4] Scoped date conversion to known tables only
        convertDateColumns() {
            CONFIG.dateTables.forEach(sel => {
                const t = document.querySelector(sel);
                if (t) t.querySelectorAll("td:not(.date-converted)").forEach(cell => {
                    const text = cell.textContent.trim();
                    if (Validators.isValidDate(text)) {
                        try { const d = new Date(text.replace(/\s[A-Z]+$/, "")); if (!isNaN(d.getTime())) { cell.textContent = d.toLocaleString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).replace(/\//g, "-"); } } catch (e) { }
                        cell.classList.add("date-converted");
                    }
                });
            });
        },
    };

    // ========================================
    // [OPT 5.1] REGISTER MODULE RESETS VIA EVENTBUS
    // ========================================
    EventBus.on("navigation", () => { HazmatIntegration.reset(); });
    EventBus.on("navigation", () => { PrepInstructionIntegration.reset(); });
    EventBus.on("navigation", () => { BoxRecIntegration.reset(); });
    EventBus.on("navigation", () => { FloorInfo.stopScanner(); FloorInfo.floorVisible = false; FloorInfo.floorLoaded = false; });

    // ========================================
    // REINITIALIZE
    // ========================================
    async function reinitializeDynamicElements() {
        Logger.info("Reinitializing dynamic elements");
        await new Promise(r => setTimeout(r, CONFIG.ui.delays.medium));
        await SafeExecute.run(() => {
            UI.createRSFilterButtons(); UI.createMaxRangeButton(); UI.createTodayButton();
            if (Validators.isLoginInURL()) UI.createFlipsToSellableButton();
            FloorInfo.attachButton(); AsinPrinting.addButtons(); Features.convertDateColumns();
            ProductTableWatcher.init();
            HazmatIntegration.init(); PrepInstructionIntegration.init(); BoxRecIntegration.init(); ReceiveHistoryFilters.init();
        }, "Reinitialize Dynamic Elements", false);
    }

    // ========================================
    // [OPT 1.3] UNIFIED OBSERVER — with relevance filtering
    // ========================================
    const UnifiedObserver = new MutationObserver(Utils.debounce((mutations) => {
        const dominated = mutations.some(m =>
            m.target.id?.includes('inventory') ||
            m.target.id?.includes('receive') ||
            m.target.id?.includes('container') ||
            m.target.closest?.('[data-section-type]') ||
            m.target.closest?.('.dataTables_wrapper')
        );
        if (!dominated && mutations.length > 0) {
            // Still check for lightweight items
            Features.convertDateColumns();
            return;
        }
        const sfd = document.getElementById("table-inventory-history_filter");
        if (sfd && !document.querySelector(".rs-filter-buttons-container")) UI.createRSFilterButtons();
        const sb = document.querySelector('[data-action="inventory-history-search-button"]');
        if (sb && !document.getElementById("maxRangeButton")) UI.createMaxRangeButton();
        if (sb && !document.getElementById("todayButton")) UI.createTodayButton();
        if (sb && !document.getElementById("flipsToSellableButton") && Validators.isLoginInURL()) UI.createFlipsToSellableButton();
        const is = document.querySelector('[data-section-type="inventory"]');
        if (is && !document.querySelector(".ff-btn-container")) FloorInfo.attachButton();
        if (is) Features.addCSVExportButton();
        Features.convertDateColumns();
        const rhf = document.getElementById("table-receive-history_filter");
        if (rhf && !document.querySelector(".rh-filter-buttons-container")) ReceiveHistoryFilters.init();
    }, CONFIG.performance.debounceDelay));
    UnifiedObserver.observe(document.body, { childList: true, subtree: true });

    // ========================================
    // INTRO SCREEN
    // ========================================
    if (window.location.href.includes("/search")) {
        $("body").append(`<div class="a-row"><div class="a-column a-span12 a-text-center" style="color:#f37d15;padding:1.25rem;"><h1 style="margin-bottom:0.3125rem;">FCResearch+ v${window.FCRPlusVersion}</h1><p style="color:#888;font-size:0.875rem;margin-bottom:1.25rem;">Fulfillment Center Research Enhanced</p><div style="margin-bottom:1.875rem;padding:0.9375rem;background:#183D3D;border-radius:0.5rem;max-width:43.75rem;margin-left:auto;margin-right:auto;"><h4 style="color:#f37d15;margin-bottom:0.625rem;">Quick Start</h4><p style="color:#E0E0E0;font-size:0.875rem;margin:0;text-align:left;line-height:1.8;"><strong>Settings Menu:</strong> Click gear icon<br><strong>Quick Print:</strong> Left side of search bar<br><strong>FC Selector:</strong> Right side of search bar<br><strong>Dark Mode:</strong> Toggle button - Default: OFF<br><strong>RS Filters:</strong> M/F/R/X buttons (Inventory History)<br><strong>Receive History Filters:</strong> Process path filter buttons<br><strong>Max Range / Today:</strong> Date range buttons<br><strong>Flips to Sellable:</strong> Filter unsellable to inventory + counter<br><strong>Bin Floor:</strong> Dropzone location from FCResearch<br><strong>Hazmat Info:</strong> PanDash integration<br><strong>Prep Instructions:</strong> Prep Manager integration<br><strong>Box Recommendation:</strong> Box Rec Browser integration<br><strong>DataMatrix Generator:</strong> Bin DataMatrix codes with grid view and history<br><strong>Alt+Click:</strong> Open in Diver<br><strong>Alt+Shift+Click:</strong> Quick print<br><strong>Right-Click:</strong> Context menu with Diver<br><strong>Hover:</strong> ASIN images and Badge photos</p></div><div style="margin-top:1.875rem;color:#666;font-size:0.75rem;"><p>Developed by josexmor</p></div></div></div>`);
    }

    // ========================================
    // MAIN INIT
    // ========================================
    async function init() {
        Logger.info(`FCResearch+ v${window.FCRPlusVersion} starting`);
        if (window.location.href.includes("diver.qts.amazon.dev")) { DiverAutoSearch.init(); return; }
        Utils.initializeCookies(); Styles.apply(); SettingsMenu.init();
        await SafeExecute.run(() => UI.createPrintmonBar(), "Printmon Bar", false);
        await SafeExecute.run(() => UI.createFCSelector(), "FC Selector", false);
        await SafeExecute.run(() => UI.createControlsContainer(), "Controls Container", false);
        await SafeExecute.run(() => UI.createDarkModeToggle(), "Dark Mode", false);
        await new Promise(r => setTimeout(r, CONFIG.ui.delays.short));
        await SafeExecute.run(() => UI.createRSFilterButtons(), "RS Filters", false);
        await SafeExecute.run(() => UI.createMaxRangeButton(), "Max Range", false);
        await SafeExecute.run(() => UI.createTodayButton(), "Today Button", false);
        if (Validators.isLoginInURL()) await SafeExecute.run(() => UI.createFlipsToSellableButton(), "Flips Button", false);
        await SafeExecute.run(() => FloorInfo.attachButton(), "Floor Info", false);
        await SafeExecute.run(() => AsinPrinting.addButtons(), "ASIN Printing", false);
        await SafeExecute.run(() => Features.convertDateColumns(), "Date Columns", false);
        ProductTableWatcher.init();
        await SafeExecute.run(() => HazmatIntegration.init(), "Hazmat Integration", false);
        await SafeExecute.run(() => PrepInstructionIntegration.init(), "Prep Integration", false);
        await SafeExecute.run(() => BoxRecIntegration.init(), "BoxRec Integration", false);
        await SafeExecute.run(() => DataMatrixGenerator.init(), "DataMatrix Generator", false);
        await SafeExecute.run(() => ReceiveHistoryFilters.init(), "Receive History Filters", false);
        AltClickDiver.init(); ContextMenu.init(); ImageHover.init(); BadgePhotos.init(); NavigationDetector.init();
        Logger.info("FCResearch+ fully loaded"); SafeExecute.toast(`FCResearch+ v${window.FCRPlusVersion} loaded!`);
        setTimeout(() => Logger.info("Cache statistics", imageCache.getStats()), CONFIG.ui.delays.veryLong);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
    EventBus.on("fc:changed", d => Logger.info("FC changed", d));
    EventBus.on("rsfilter:changed", d => Logger.info("RS filter changed", d));
    EventBus.on("flips:changed", d => Logger.info("Flips changed", d));
})();
