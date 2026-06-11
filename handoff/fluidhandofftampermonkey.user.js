// ==UserScript==
// @name         Fluid West Handoff Capture
// @namespace    fluid-west-handoff
// @version      0.7.1
// @description  Capture DockFlow, YMS, and SSP data for the Fluid West handoff builder.
// @match        https://prod-na.dockflow.robotics.a2z.com/RFD2/wc/MainSorter/Sorter*
// @match        https://trans-logistics.amazon.com/yms/shipclerk/*
// @match        https://trans-logistics.amazon.com/ssp/dock/hrz/ob*
// @match        https://ont-base.corp.amazon.com/RFD2/icqa/piles*
// @match        https://cgi.contguard.com/shipment-manager*
// @match        file:///C:/Users/jonavroa/Documents/EOS%20WASH/index.html
// @match        http://127.0.0.1:4173/*
// @match        http://localhost:4173/*
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  "use strict";

  const ownerCodes = ["AZNG", "AZNU", "HGIU", "JBHU", "AWDJA"];
  const dockflowHistoryKey = "fluidDockflowHistory";
  const lastCaptureKey = "fluidLastCapture";
  const panelPositionKey = "fluidCapturePanelPosition";
  const westDoorMin = 338;
  const westDoorMax = 355;
  const excludedWestDoors = new Set([340]);

  function nowStamp() {
    return new Date().toISOString();
  }

  function visibleText(element) {
    return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function getRows() {
    const candidates = Array.from(document.querySelectorAll("tr, [role='row'], [data-rowindex], .ag-row, .MuiDataGrid-row"));
    const rows = candidates.map(visibleText).filter((text) => text.length > 8);
    if (rows.length) {
      return Array.from(new Set(rows));
    }
    return visibleText(document.body)
      .split(/(?=DD\d{3}|PS\s*-?\s*\d{3,4}|WS\s*-?\s*\d{3,4}|AZNG|AZNU|HGIU|JBHU|AWDJA|csX|tsX)/i)
      .map((text) => text.trim())
      .filter((text) => text.length > 8);
  }

  function getElementSignal(element) {
    if (!element) {
      return "";
    }
    const attributes = ["aria-label", "title", "alt", "data-testid", "data-test", "data-field", "data-col-id", "class"];
    const values = attributes.map((name) => element.getAttribute?.(name) || "");
    return values.join(" ");
  }

  function getYmsRows() {
    const candidates = Array.from(document.querySelectorAll("tr, [role='row'], [data-rowindex], .ag-row, .MuiDataGrid-row"));
    const records = candidates
      .map((element) => ({
        element,
        text: visibleText(element),
        signal: [
          getElementSignal(element),
          ...Array.from(element.querySelectorAll("[aria-label], [title], [alt], [data-testid], [data-test], [data-field], [data-col-id], [class]"))
            .slice(0, 120)
            .map(getElementSignal)
        ].join(" ")
      }))
      .filter((row) => row.text.length > 8);
    if (records.length) {
      const seen = new Set();
      return records.filter((row) => {
        const key = `${row.text} ${row.signal}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    }
    return getRows().map((text) => ({ element: null, text, signal: "" }));
  }

  function isYellowishColor(value) {
    const match = String(value || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) {
      return false;
    }
    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    return red >= 180 && green >= 150 && blue <= 120 && red > blue * 1.6 && green > blue * 1.4;
  }

  function hasYellowVisualMarker(element) {
    if (!element) {
      return false;
    }
    const elements = [element, ...Array.from(element.querySelectorAll("*")).slice(0, 120)];
    return elements.some((child) => {
      const style = window.getComputedStyle(child);
      return isYellowishColor(style.backgroundColor) || isYellowishColor(style.color) || isYellowishColor(style.borderColor);
    });
  }

  function isYellowTaggedYmsRow(row) {
    const marker = `${row.text} ${row.signal}`.toUpperCase();
    if (/YELLOW[\s_-]*(?:TAG|TAGGED)|TAGGED[\s_-]*YELLOW|YELLOWTAG/.test(marker)) {
      return true;
    }
    return /(?:\bYT\b|YELLOW)/.test(marker) && hasYellowVisualMarker(row.element);
  }

  function getDoorNumber(text) {
    const match = text.match(/\bDD(3\d{2})\b/i);
    return match ? Number(match[1]) : undefined;
  }

  function isWestDoorNumber(doorNumber) {
    return doorNumber >= westDoorMin && doorNumber <= westDoorMax && !excludedWestDoors.has(doorNumber);
  }

  function hasWestDoor(text) {
    const doorNumber = getDoorNumber(text);
    return doorNumber !== undefined && isWestDoorNumber(doorNumber);
  }

  function hasDd300Door(text) {
    return /\bDD3\d{2}\b/i.test(text);
  }

  function getSlipNumber(text, prefix) {
    const pattern = new RegExp(`\\b${prefix}\\s*-?\\s*(\\d{3,4})\\b`, "i");
    const match = text.match(pattern);
    return match ? Number(match[1]) : undefined;
  }

  function isWestEmptySlip(text) {
    const ps = getSlipNumber(text, "PS");
    if (ps !== undefined && ps >= 1100 && ps <= 1300) {
      return true;
    }
    const ws = getSlipNumber(text, "WS");
    return ws !== undefined && ws >= 356 && ws <= 358;
  }

  function copyPayload(payload, label) {
    const text = JSON.stringify(payload, null, 2);
    GM_setValue(lastCaptureKey, text);
    GM_setClipboard(text, "text");
    setStatus(`${label} copied. Paste it into Site Capture Import in the builder.`);
  }

  function getNumberCandidates(text) {
    return Array.from(text.matchAll(/\b\d{1,6}\b/g))
      .map((match) => Number(match[0]))
      .filter((num) => Number.isFinite(num));
  }

  function parseRecircs(text) {
    const labeled = text.match(/(?:recircs?|recirc)\D{0,20}(\d{1,6})/i);
    if (labeled) {
      return Number(labeled[1]);
    }
    const numbers = getNumberCandidates(text).filter((num) => num < 100000);
    return numbers.length ? numbers[numbers.length - 1] : 0;
  }

  function parseDockflowRows() {
    return getRows()
      .map((text) => {
        const doorMatch = text.match(/\bDD\d{3}\b/i);
        if (!doorMatch) {
          return null;
        }
        if (!hasWestDoor(text)) {
          return null;
        }
        const afterDoor = text.slice(doorMatch.index + doorMatch[0].length);
        const destMatch = afterDoor.match(/\b[A-Z]{3,5}\d?\b/);
        const arc = `${doorMatch[0].toUpperCase()}${destMatch ? ` ${destMatch[0]}` : ""}`;
        return {
          arc,
          recircs: parseRecircs(text),
          raw: text
        };
      })
      .filter(Boolean)
      .filter((row) => row.recircs > 0)
      .sort((a, b) => b.recircs - a.recircs);
  }

  function aggregateDockflowHistory(limit, rankBy = "total") {
    const history = GM_getValue(dockflowHistoryKey, []);
    const totals = new Map();
    history.forEach((snapshot) => {
      (snapshot.rows || []).forEach((row) => {
        const existing = totals.get(row.arc) || { arc: row.arc, recircs: 0, captures: 0 };
        existing.recircs += Number(row.recircs || 0);
        existing.captures += 1;
        totals.set(row.arc, existing);
      });
    });
    return Array.from(totals.values())
      .map((row) => ({ ...row, averageRecircs: row.captures ? row.recircs / row.captures : 0 }))
      .sort((a, b) => {
        if (rankBy === "average") {
          return b.averageRecircs - a.averageRecircs;
        }
        return b.recircs - a.recircs;
      })
      .slice(0, limit)
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  function dockflowTopByPeriod(limit) {
    const history = GM_getValue(dockflowHistoryKey, []);
    return history.map((snapshot) => ({
      period: snapshot.period || "Current period",
      capturedAt: snapshot.capturedAt,
      rows: (snapshot.rows || [])
        .slice()
        .sort((a, b) => b.recircs - a.recircs)
        .slice(0, limit)
        .map((row, index) => ({ ...row, rank: index + 1, period: snapshot.period || "Current period" }))
    }));
  }

  function captureDockflow() {
    const isMet = document.querySelector("#fluidMetMode")?.checked || false;
    const periodLabel = document.querySelector("#fluidPeriodLabel")?.value.trim() || "Current period";
    const periodLimit = 3;
    const shiftLimit = 5;
    const rows = parseDockflowRows();
    const history = GM_getValue(dockflowHistoryKey, []);
    history.push({ capturedAt: nowStamp(), period: periodLabel, rows });
    GM_setValue(dockflowHistoryKey, history.slice(-24));

    const payload = {
      source: "dockflow",
      capturedAt: nowStamp(),
      mode: isMet ? "MET" : "standard",
      period: periodLabel,
      periodTop: rows.slice(0, periodLimit).map((row, index) => ({ ...row, rank: index + 1, period: periodLabel })),
      periodsTop: dockflowTopByPeriod(periodLimit),
      shiftTop: aggregateDockflowHistory(shiftLimit, "total"),
      shiftAverageTop: aggregateDockflowHistory(shiftLimit, "average")
    };
    copyPayload(payload, "DockFlow capture");
  }

  function clearDockflowHistory() {
    GM_setValue(dockflowHistoryKey, []);
    setStatus("DockFlow shift history cleared.");
  }

  function parseYmsPool() {
    const pool = Object.fromEntries(ownerCodes.map((code) => [code, 0]));
    const rows = getYmsRows();
    rows.forEach((row) => {
      const text = row.text;
      const upper = text.toUpperCase();
      if (!isWestEmptySlip(upper)) {
        return;
      }
      if (/\bDD3\d{2}\b/.test(upper) && !hasWestDoor(upper)) {
        return;
      }
      const code = ownerCodes.find((owner) => upper.includes(owner));
      if (!code) {
        return;
      }
      if ((code === "AZNG" || code === "AZNU") && isYellowTaggedYmsRow(row)) {
        return;
      }
      pool[code] += 1;
    });
    return pool;
  }

  function captureYms() {
    copyPayload({
      source: "yms",
      capturedAt: nowStamp(),
      note: "Trailer pool limited to PS1100-PS1300 and WS356-WS358. AZNG/AZNU exclude visible yellow tag rows. Rows with DD doors are limited to DD338-DD355 excluding DD340.",
      trailerPool: parseYmsPool()
    }, "YMS trailer pool");
  }

  function parseMetric(text, key) {
    const pattern = new RegExp(`${key}\\s*[:=]?\\s*(\\d{1,6})`, "i");
    const match = text.match(pattern);
    return match ? Number(match[1]) : undefined;
  }

  function parseWeight(text) {
    const labeled = text.match(/(?:payload\s+weight(?:\s*\(unit\))?|weight\s*\(unit\)|\bweight\b)\D{0,30}(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d{4,6}(?:\.\d+)?)/i);
    if (labeled) {
      return Number(labeled[1].replace(/,/g, ""));
    }
    const withUnit = text.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d{4,6}(?:\.\d+)?)\s*\(?\s*lb/i);
    return withUnit ? Number(withUnit[1].replace(/,/g, "")) : undefined;
  }

  function parseSdt(text) {
    const labeled = text.match(/(?:scheduled\s+departure\s+time|sdt)\D{0,30}(\d{1,2}-[A-Za-z]{3}-\d{2,4}\s+\d{1,2}:\d{2})/i);
    if (labeled) {
      return labeled[1];
    }
    const dateTime = text.match(/\b\d{1,2}-[A-Za-z]{3}-\d{2,4}\s+\d{1,2}:\d{2}\b/);
    return dateTime ? dateTime[0] : "";
  }

  function classifyLoad(cases, totes, text = "") {
    if (/hybrid/i.test(text)) {
      return "HYBRID";
    }
    if (/pure\s*case|case/i.test(text) && !/tote/i.test(text)) {
      return "PURE CASE";
    }
    if (/tote/i.test(text) && !/case/i.test(text)) {
      return "TOTE";
    }
    if (totes > 0 && !cases) {
      return "TOTE";
    }
    if (cases > 0 && totes > 0) {
      return "HYBRID";
    }
    if (cases > 0) {
      return "PURE CASE";
    }
    return "";
  }

  function loadStatus(loadType, payloadWeight) {
    if (loadType === "TOTE") {
      if (!payloadWeight) {
        return "Tote trailer - weight not found";
      }
      return payloadWeight < 30000 ? "Tote trailer - allowed below 30k" : "Tote trailer - 30k+ check";
    }
    if (loadType === "PURE CASE" || loadType === "HYBRID") {
      if (!payloadWeight) {
        return `${loadType} - weight not found`;
      }
      if (payloadWeight >= 33000 && payloadWeight <= 40000) {
        return "In 33k-40k target";
      }
      if (payloadWeight < 33000) {
        return "Below 33k target";
      }
      return "At/over 40k limit check";
    }
    if (payloadWeight) {
      if (payloadWeight < 30000) {
        return "Below 30k - tote OK, case/hybrid low";
      }
      if (payloadWeight < 33000) {
        return "30k-33k - check load type";
      }
      if (payloadWeight <= 40000) {
        return "33k-40k target";
      }
      return "At/over 40k limit check";
    }
    return "";
  }

  function parseSspRows() {
    const hierarchyRows = parseContainerHierarchyRows();
    const visibleRows = getRows()
      .map((text) => {
        const doorMatch = text.match(/\bDD\d{3}\b/i);
        if (doorMatch && !hasWestDoor(text)) {
          return null;
        }
        if (!doorMatch) {
          return null;
        }
        const loadMatch = text.match(/\b[A-Z]{3,5}\d?\b.*?\bDD\d{3}\b|\bDD\d{3}\b.*?\b[A-Z]{3,5}\d?\b/i);
        const percentMatch = text.match(/(\d{1,3})\s*%/);
        const cases = parseMetric(text, "csX");
        const totes = parseMetric(text, "tsX");
        const payloadWeight = parseWeight(text);
        const scheduledDepartureTime = parseSdt(text);
        if (!doorMatch && cases === undefined && totes === undefined && !percentMatch) {
          return null;
        }
        const loadType = classifyLoad(cases || 0, totes || 0, text);
        return {
          load: loadMatch ? loadMatch[0].trim() : (doorMatch ? doorMatch[0].toUpperCase() : "UNKNOWN"),
          door: doorMatch ? doorMatch[0].toUpperCase() : "",
          percent: percentMatch ? Number(percentMatch[1]) : undefined,
          cases,
          totes,
          payloadWeight,
          scheduledDepartureTime,
          loadType,
          status: loadStatus(loadType, payloadWeight),
          raw: text
        };
      })
      .filter(Boolean);
    return mergeSspRows([...hierarchyRows, ...visibleRows]);
  }

  function parseContainerHierarchyRows() {
    return getTableRowCells()
      .map((cells) => {
        const joined = cells.join(" ");
        if (!/\bDD\d{3}\b/i.test(joined) && !/payload\s+weight/i.test(joined) && !/\bweight\b/i.test(joined)) {
          return null;
        }
        const doorMatch = joined.match(/\bDD\d{3}\b/i);
        if (!doorMatch || !hasWestDoor(joined)) {
          return null;
        }
        const vrId = cells.find((cell) => /^\d{3}[A-Z0-9]{4,}$/i.test(cell)) || "";
        const scheduledDepartureTime = parseSdt(joined);
        const payloadWeight = parseWeight(joined);
        const location = (cells.find((cell) => /^PS\s*-?\s*\d{3,4}$/i.test(cell)) || "").replace(/\s+/g, "");
        if (!vrId && !scheduledDepartureTime && payloadWeight === undefined) {
          return null;
        }
        return {
          load: vrId || (doorMatch ? doorMatch[0].toUpperCase() : "UNKNOWN"),
          door: doorMatch ? doorMatch[0].toUpperCase() : "",
          location,
          scheduledDepartureTime,
          payloadWeight,
          loadType: "",
          status: loadStatus("", payloadWeight),
          raw: joined
        };
      })
      .filter(Boolean);
  }

  function mergeSspRows(rows) {
    const merged = new Map();
    rows.forEach((row) => {
      const key = row.load || row.door || row.raw;
      const existing = merged.get(key) || {};
      merged.set(key, { ...existing, ...row });
    });
    return Array.from(merged.values());
  }

  function captureSsp() {
    const rows = parseSspRows();
    const nextToClose = rows
      .filter((row) => row.door && hasWestDoor(row.door))
      .filter((row) => row.scheduledDepartureTime || row.percent !== undefined || row.payloadWeight !== undefined)
      .sort((a, b) => {
        if (a.scheduledDepartureTime && !b.scheduledDepartureTime) {
          return -1;
        }
        if (!a.scheduledDepartureTime && b.scheduledDepartureTime) {
          return 1;
        }
        return String(a.scheduledDepartureTime || "").localeCompare(String(b.scheduledDepartureTime || "")) || Number(b.percent || 0) - Number(a.percent || 0);
      })
      .slice(0, 5)
      .map((row, index) => `${index + 1}. ${formatTdrLine(row)}`);
    copyPayload({
      source: "ssp",
      capturedAt: nowStamp(),
      loadNotes: rows,
      nextToClose
    }, "SSP capture");
  }

  function formatTdrLine(row) {
    const pieces = [row.load || row.door || "UNKNOWN"];
    if (row.scheduledDepartureTime) {
      pieces.push(`SDT ${row.scheduledDepartureTime}`);
    }
    if (row.percent !== undefined) {
      pieces.push(`${row.percent}%`);
    }
    if (row.payloadWeight !== undefined) {
      pieces.push(`${Math.round(row.payloadWeight).toLocaleString()} lb`);
    }
    if (row.location) {
      pieces.push(row.location);
    }
    if (row.status) {
      pieces.push(row.status);
    }
    return pieces.join(" - ");
  }

  function numberFromCell(text) {
    const match = String(text || "").match(/-?\d+/);
    return match ? Number(match[0]) : 0;
  }

  function getTableRowCells() {
    return Array.from(document.querySelectorAll("tr, [role='row']"))
      .map((row) => Array.from(row.querySelectorAll("th, td, [role='cell'], [role='gridcell'], [role='columnheader']")).map(visibleText))
      .filter((cells) => cells.length >= 6);
  }

  function parseFluidLoadRow(cells) {
    const labelIndex = cells.findIndex((cell) => /^(west\s+)?fluid\s+load$/i.test(cell));
    if (labelIndex === -1) {
      return null;
    }
    const isWest = /^west\s+fluid\s+load$/i.test(cells[labelIndex]);
    const offset = labelIndex + 1;
    return {
      label: cells[labelIndex],
      totes: numberFromCell(cells[offset]),
      cases: numberFromCell(cells[offset + 1]),
      packages: numberFromCell(cells[offset + 2]),
      carts: numberFromCell(cells[offset + 3]),
      cages: numberFromCell(cells[offset + 4]),
      pallets: numberFromCell(cells[offset + 5]),
      units: numberFromCell(cells[offset + 6]),
      total: numberFromCell(cells[offset + 7]),
      isWest
    };
  }

  function parsePilesRows() {
    const rows = getTableRowCells().map(parseFluidLoadRow).filter(Boolean);
    const summary = rows.find((row) => !row.isWest) || null;
    const westFluidLoad = rows.find((row) => row.isWest) || null;
    const sourceRow = summary || westFluidLoad;
    const pileCount = sourceRow ? (sourceRow.carts || 0) + (sourceRow.cages || 0) + (sourceRow.pallets || 0) : 0;
    return { summary, westFluidLoad, pileCount };
  }

  function capturePiles() {
    const piles = parsePilesRows();
    copyPayload({
      source: "piles",
      capturedAt: nowStamp(),
      pileCount: piles.pileCount,
      summary: piles.summary,
      westFluidLoad: piles.westFluidLoad
    }, "Problem Solve piles");
  }

  function parseDateFromText(text, shiftStart) {
    const isoLike = text.match(/\b\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?\b/);
    if (isoLike) {
      const date = new Date(isoLike[0].replace(" ", "T"));
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const usDate = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?\b/i);
    if (usDate) {
      let hour = Number(usDate[4]);
      const meridiem = (usDate[6] || "").toUpperCase();
      if (meridiem === "PM" && hour < 12) {
        hour += 12;
      }
      if (meridiem === "AM" && hour === 12) {
        hour = 0;
      }
      const year = Number(usDate[3].length === 2 ? `20${usDate[3]}` : usDate[3]);
      return new Date(year, Number(usDate[1]) - 1, Number(usDate[2]), hour, Number(usDate[5]));
    }
    const timeOnly = text.match(/\b(\d{1,2}):(\d{2})(?:\s*([AP]M))?\b/i);
    if (!timeOnly) {
      return null;
    }
    let hour = Number(timeOnly[1]);
    const meridiem = (timeOnly[3] || "").toUpperCase();
    if (meridiem === "PM" && hour < 12) {
      hour += 12;
    }
    if (meridiem === "AM" && hour === 12) {
      hour = 0;
    }
    const inferred = new Date(shiftStart);
    inferred.setHours(hour, Number(timeOnly[2]), 0, 0);
    if (inferred < shiftStart && hour < 12) {
      inferred.setDate(inferred.getDate() + 1);
    }
    return inferred;
  }

  function getShiftWindow(isMet) {
    const now = new Date();
    const start = new Date(now);
    if (now.getHours() < 12) {
      start.setDate(start.getDate() - 1);
    }
    start.setHours(19, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    end.setHours(isMet ? 6 : 5, isMet ? 30 : 30, 0, 0);
    return { start, end };
  }

  function formatTimeWindow(start, end) {
    return `${start.toLocaleString()} - ${end.toLocaleString()}`;
  }

  function parseSmartlockRows(shiftStart, shiftEnd) {
    return getRows()
      .map((text) => {
        const createdAt = parseDateFromText(text, shiftStart);
        if (!createdAt || createdAt < shiftStart || createdAt > shiftEnd) {
          return null;
        }
        return {
          createdAt: createdAt.toISOString(),
          raw: text
        };
      })
      .filter(Boolean);
  }

  function captureSmartlocks() {
    const isMet = document.querySelector("#fluidSmartlockMetMode")?.checked || false;
    const { start, end } = getShiftWindow(isMet);
    const rows = parseSmartlockRows(start, end);
    copyPayload({
      source: "smartlocks",
      capturedAt: nowStamp(),
      mode: isMet ? "MET" : "regular",
      count: rows.length,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      windowLabel: isMet ? "7:00pm-6:30am MET" : "7:00pm-5:30am regular",
      rows
    }, `Smartlocks ${formatTimeWindow(start, end)}`);
  }

  function pasteLastCaptureIntoBuilder() {
    const capture = GM_getValue(lastCaptureKey, "");
    const box = document.querySelector("#captureJson");
    const button = document.querySelector("#importCaptureBtn");
    if (!box || !button || !capture) {
      setStatus("No saved capture found yet.");
      return;
    }
    box.value = capture;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
    setStatus("Last capture pasted into builder.");
  }

  function captureBuilderReportCard() {
    const report = document.querySelector("#reportOutput")?.textContent || "";
    const fields = {};
    Array.from(document.querySelectorAll("input[id], textarea[id], select[id]")).forEach((input) => {
      if (input.id === "captureJson") {
        return;
      }
      fields[input.id] = input.value;
    });
    copyPayload({
      source: "builder",
      capturedAt: nowStamp(),
      report,
      fields
    }, "Builder report card");
  }

  function copyBuilderReportText() {
    const report = document.querySelector("#reportOutput")?.textContent || "";
    GM_setClipboard(report, "text");
    setStatus("Current handoff report copied.");
  }

  function setStatus(text) {
    const status = document.querySelector("#fluidCaptureStatus");
    if (status) {
      status.textContent = text;
    }
  }

  function addPanel() {
    if (document.querySelector("#fluidCapturePanel")) {
      return;
    }
    const panel = document.createElement("div");
    panel.id = "fluidCapturePanel";
    panel.innerHTML = `
      <style>
        #fluidCapturePanel {
          position: fixed;
          right: 14px;
          bottom: 14px;
          z-index: 999999;
          width: 260px;
          border: 1px solid #c7ced8;
          border-radius: 8px;
          padding: 10px;
          background: #fff;
          color: #111827;
          box-shadow: 0 8px 28px rgba(0,0,0,.18);
          font: 13px Arial, sans-serif;
        }
        #fluidCaptureHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 8px;
          cursor: move;
          user-select: none;
        }
        #fluidCaptureHeader strong {
          font-size: 14px;
        }
        #fluidCaptureHandle {
          color: #6b7280;
          font-size: 12px;
          font-weight: 700;
        }
        #fluidCapturePanel button {
          width: 100%;
          margin-top: 7px;
          border: 1px solid #1463ff;
          border-radius: 6px;
          padding: 8px;
          background: #1463ff;
          color: #fff;
          font-weight: 700;
          cursor: pointer;
        }
        #fluidCapturePanel label {
          display: flex;
          align-items: center;
          gap: 7px;
          margin: 8px 0;
        }
        #fluidCapturePanel input {
          width: auto;
        }
        #fluidCapturePanel input[type="text"] {
          width: 100%;
          min-width: 0;
          border: 1px solid #c7ced8;
          border-radius: 6px;
          padding: 6px;
        }
        #fluidCaptureStatus {
          margin-top: 8px;
          min-height: 18px;
          color: #374151;
        }
      </style>
      <div id="fluidCaptureHeader"><strong>Fluid Capture</strong><span id="fluidCaptureHandle">move</span></div>
      <div id="fluidCaptureActions"></div>
      <div id="fluidCaptureStatus"></div>
    `;
    document.body.appendChild(panel);
    restorePanelPosition(panel);
    makePanelDraggable(panel);

    const actions = panel.querySelector("#fluidCaptureActions");
    const host = location.host;
    const path = location.href;
    if (host.includes("dockflow")) {
      actions.append(makeCheckbox("fluidMetMode", "MET mode"));
      actions.append(makeTextInput("fluidPeriodLabel", "Period label", "Current period"));
      actions.append(makeButton("Capture DockFlow arcs", captureDockflow));
      actions.append(makeButton("Clear DockFlow shift history", clearDockflowHistory));
    } else if (path.includes("/yms/shipclerk/")) {
      actions.append(makeButton("Capture YMS trailer pool", captureYms));
    } else if (path.includes("/ssp/dock/hrz/ob")) {
      actions.append(makeButton("Capture SSP loads", captureSsp));
    } else if (path.includes("/RFD2/icqa/piles")) {
      actions.append(makeButton("Capture Problem Solve piles", capturePiles));
    } else if (host.includes("cgi.contguard.com")) {
      actions.append(makeCheckbox("fluidSmartlockMetMode", "MET day"));
      actions.append(makeButton("Capture Smartlocks created", captureSmartlocks));
    } else if (location.protocol === "file:" || host.startsWith("127.0.0.1") || host.startsWith("localhost")) {
      actions.append(makeButton("Paste last capture into builder", pasteLastCaptureIntoBuilder));
      actions.append(makeButton("Copy current handoff", copyBuilderReportText));
      actions.append(makeButton("Export report card JSON", captureBuilderReportCard));
    }
  }

  function restorePanelPosition(panel) {
    const position = GM_getValue(panelPositionKey, null);
    if (!position) {
      return;
    }
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function makePanelDraggable(panel) {
    const header = panel.querySelector("#fluidCaptureHeader");
    if (!header) {
      return;
    }
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragging = false;

    header.addEventListener("mousedown", (event) => {
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = `${startLeft}px`;
      panel.style.top = `${startTop}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      event.preventDefault();
    });

    document.addEventListener("mousemove", (event) => {
      if (!dragging) {
        return;
      }
      const nextLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, startLeft + event.clientX - startX));
      const nextTop = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, startTop + event.clientY - startY));
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      GM_setValue(panelPositionKey, {
        left: Number.parseInt(panel.style.left, 10) || 0,
        top: Number.parseInt(panel.style.top, 10) || 0
      });
    });
  }

  function makeButton(text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function makeCheckbox(id, text) {
    const label = document.createElement("label");
    label.innerHTML = `<input id="${id}" type="checkbox"> ${text}`;
    return label;
  }

  function makeTextInput(id, labelText, value) {
    const label = document.createElement("label");
    label.innerHTML = `<span>${labelText}</span><input id="${id}" type="text" value="${value}">`;
    return label;
  }

  addPanel();
})();
