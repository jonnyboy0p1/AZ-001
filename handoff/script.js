const fields = [
  "greeting",
  "shiftType",
  "overallStatus",
  "mainRisk",
  "actionNeeded",
  "handoffNotes",
  "yardNotes",
  "followUps",
  "captureJson",
  "availableCarriers",
  "floorNotes",
  "azng",
  "aznu",
  "hgiu",
  "jbhu",
  "awdja",
  "awdjaNote",
  "truePauseLoad",
  "truePauseDetails",
  "locksUsed",
  "smartLocksCreated",
  "smartLockNote",
  "nextSdt",
  "psStaffing",
  "psCase",
  "psTote",
  "psPiles",
  "fluidLoadDetails",
  "busyArcs",
  "allShiftArcs",
  "totalUBoats",
  "downstackUBoats",
  "downstackDetails",
  "jackpot",
  "jamNotes",
  "pendingRme",
  "sspLoadNotes",
  "doorsNextToClose",
  "doorsToOpen",
  "percentagesUpdated",
  "cpBusyArcs",
  "cpDownstack",
  "cpProblemSolve",
  "cpWatchOut",
  "cpSosTodo",
  "cpRme",
  "lsEastYard",
  "lsWestYard",
  "lsSmartLocks",
  "lsPauseLoads",
  "lsReadyForClose",
  "lsDoorsClosing",
  "lsOpenCapacity",
  "lsRecurringIssues",
  "lsCriticalTrailers",
  "lsEscalations",
  "lsShiftHealth",
  "lsHealthReason"
];

const storageKey = "fluidWestHandoff";
const activeTabKey = "fluidWestHandoffTab";
const separator = "-------------------------------------------------------------";
const noteSeparator = "-----";
const defaults = new Map();
const output = document.querySelector("#reportOutput");
const copyStatus = document.querySelector("#copyStatus");
const importStatus = document.querySelector("#importStatus");
let activeTab = localStorage.getItem(activeTabKey) || "full";

function field(id) {
  return document.querySelector(`#${id}`);
}

function value(id) {
  return field(id).value.trim();
}

function numberValue(id) {
  const raw = value(id);
  if (!raw) {
    return "";
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : "";
}

function cleanLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function lineList(text) {
  return cleanLines(text).split("\n").filter(Boolean);
}

function trailerPoolLine(label, id, noteId) {
  const base = value(id);
  const note = noteId ? value(noteId) : "";
  if (!base && !note) {
    return "";
  }
  return `${label}: ${base || "0"}${note ? ` ${note}` : ""}`;
}

function joinLines(lines) {
  return lines
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .join("\n");
}

function section(title, body) {
  const clean = cleanLines(body);
  if (!clean) {
    return "";
  }
  return `${separator}\n ${title}\n\n${clean}`;
}

function noteBlock(title, body) {
  const clean = cleanLines(body);
  if (!clean) {
    return "";
  }
  return `${noteSeparator}\n${title}\n${clean}`;
}

function labelLine(label, body) {
  const clean = cleanLines(body);
  return clean ? `${label}: ${clean}` : "";
}

function firstLines(text, limit) {
  return cleanLines(text)
    .split("\n")
    .filter(Boolean)
    .slice(0, limit)
    .join("\n");
}

function buildReport() {
  const floorNotes = joinLines([
    value("availableCarriers") ? `Available carriers at the EOS: ${numberValue("availableCarriers")}` : "",
    cleanLines(value("floorNotes"))
  ]);

  const trailerPool = joinLines([
    trailerPoolLine("AZNG", "azng"),
    trailerPoolLine("AZNU", "aznu"),
    trailerPoolLine("HGIU", "hgiu"),
    trailerPoolLine("JBHU", "jbhu"),
    trailerPoolLine("AWDJA", "awdja", "awdjaNote")
  ]);

  const smartLocks = joinLines([
    value("locksUsed") ? `LOCKS USED: ${numberValue("locksUsed")}` : "",
    value("smartLocksCreated") ? `SMARTLOCKS CREATED THIS SHIFT: ${numberValue("smartLocksCreated")}` : "",
    cleanLines(value("smartLockNote"))
  ]);

  const shipclerkNotes = joinLines([
    trailerPool ? `TRAILER POOL\n${trailerPool}` : "",
    value("truePauseLoad") || cleanLines(value("truePauseDetails"))
      ? `TRUE PAUSE LOAD: ${numberValue("truePauseLoad")}\n${cleanLines(value("truePauseDetails"))}` : "",
    smartLocks ? `SMART LOCKS\n${smartLocks}` : "",
    cleanLines(value("nextSdt")) ? `NEXT SDT TO EXPIRE SOON:\n${cleanLines(value("nextSdt"))}` : ""
  ]);

  const problemSolverNotes = joinLines([
    cleanLines(value("psStaffing")),
    value("psCase") ? `PS Case: ${numberValue("psCase")}` : "",
    value("psTote") ? `PS Tote: ${numberValue("psTote")}` : "",
    value("psPiles") ? `PS Piles: ${numberValue("psPiles")}` : "",
    value("fluidLoadDetails")
  ]);

  const busyArcs = joinLines([
    cleanLines(value("busyArcs")),
    cleanLines(value("allShiftArcs"))
  ]);

  const downstackNotes = joinLines([
    value("totalUBoats") ? `Total U-Boat count: ${numberValue("totalUBoats")}` : "",
    value("downstackUBoats") ? `Down stack U-Boats: ${numberValue("downstackUBoats")}` : "",
    cleanLines(value("downstackDetails")),
    value("jackpot") ? `Jackpot U-Boats/Pallets: ${value("jackpot")}` : ""
  ]);

  const jamNotes = joinLines([
    cleanLines(value("jamNotes")) ? `Constant/Reoccurring Jams\n${cleanLines(value("jamNotes"))}` : "",
    cleanLines(value("pendingRme")) ? `Pending RME trouble tickets/pending support issues:\n${cleanLines(value("pendingRme"))}` : ""
  ]);

  const tdrNotes = joinLines([
    cleanLines(value("sspLoadNotes")) ? `SSP WEIGHT/LOAD NOTES\n${cleanLines(value("sspLoadNotes"))}` : "",
    cleanLines(value("doorsNextToClose")) ? `TOP VRIDS TO EXPIRE / CLOSE NEAR SOS\n${firstLines(value("doorsNextToClose"), 5)}` : "",
    cleanLines(value("doorsToOpen")) ? `DOORS TO OPEN AT SOS\n${cleanLines(value("doorsToOpen"))}` : "",
    value("percentagesUpdated") ? `PERCENTAGES UPDATED ---> ${value("percentagesUpdated")}` : ""
  ]);

  const yardSnapshot = joinLines([
    value("availableCarriers") ? `Available carriers: ${numberValue("availableCarriers")}` : "",
    trailerPool ? `Trailer pool\n${trailerPool}` : "",
    cleanLines(value("yardNotes")),
    cleanLines(value("doorsNextToClose")) ? `Top VRIDs to watch\n${firstLines(value("doorsNextToClose"), 5)}` : "",
    cleanLines(value("doorsToOpen")) ? `Doors to open at SOS\n${cleanLines(value("doorsToOpen"))}` : "",
    value("smartLocksCreated") ? `Smartlocks created: ${numberValue("smartLocksCreated")}` : ""
  ]);

  const eosWash = joinLines([
    labelLine("STATUS", value("overallStatus")),
    labelLine("MAIN RISK", value("mainRisk")),
    labelLine("DAYSHIFT ACTION NEEDED", value("actionNeeded")),
    noteBlock("WHAT HAPPENED THIS SHIFT", value("handoffNotes")),
    noteBlock("YARD / FLOW SNAPSHOT", yardSnapshot),
    noteBlock("DAYSHIFT ACTION ITEMS", value("followUps"))
  ]);

  return joinLines([`FLUID WEST HANDOFF :gr-not-like-duck:`,
  value("greeting"),
  value("shiftType") ? `SHIFT TYPE: ${value("shiftType")}` : "",
  section("-EOS WASH", eosWash),
  section("-FLOOR NOTES", floorNotes),
  section("-SHIPCLERK NOTES", shipclerkNotes),
  section("-PROBLEM SOLVER NOTES", problemSolverNotes),
  section("-BUSY ARCS/HEAVY ARCS", busyArcs),
  section("-DOWNSTACK NOTES", downstackNotes),
  section("-JAM NOTES", jamNotes),
  section("-TDR NOTES", tdrNotes),
  separator
]);
}

function bulletBlock(title, text) {
  const lines = lineList(text).map((line) => `* ${line.replace(/^[*•-]\s*/, "")}`);
  if (!lines.length) {
    return "";
  }
  return `${title}\n\n${lines.join("\n")}`;
}

function buildCounterpartReport() {
  const busy = lineList(value("cpBusyArcs")).join(", ");
  return [
    "🌅 WEST FLUID HANDOFF",
    busy ? `• Busy ARCs: ${busy}` : "",
    bulletBlock("• Downstack Remaining:", value("cpDownstack")),
    bulletBlock("• Problem Solve:", value("cpProblemSolve")),
    bulletBlock("• Watch Out:", value("cpWatchOut")),
    bulletBlock("• SOS To Do:", value("cpSosTodo")),
    value("cpRme")
  ].filter(Boolean).join("\n\n");
}

function fillIn(id, blank = "___") {
  return value(id) || blank;
}

function fillInBullets(text, blank, marker = "*") {
  const lines = lineList(text);
  if (!lines.length) {
    return `${marker} ${blank}`;
  }
  return lines.map((line) => `${marker} ${line.replace(/^[*•-]\s*/, "")}`).join("\n");
}

function buildLeadershipReport() {
  return [
    "📊 WEST FLUID LEADERSHIP SNAPSHOT",
    [
      "Yard Health",
      `• East Yard: ${fillIn("lsEastYard")}`,
      `• West Yard: ${fillIn("lsWestYard")}`,
      `• Smart Locks: ${fillIn("lsSmartLocks")}`,
      `• Pause Loads: ${fillIn("lsPauseLoads")}`
    ].join("\n"),
    [
      "Trailer Status",
      `• Ready for Close: ${fillIn("lsReadyForClose")}`,
      `• Doors Closing <2hr: ${fillIn("lsDoorsClosing")}`,
      `• Open Capacity: ${fillIn("lsOpenCapacity")}`
    ].join("\n"),
    `Operations Risk\n• Recurring Issues:\n\n${fillInBullets(value("lsRecurringIssues"), "---")}`,
    `Critical Trailers\n${fillInBullets(value("lsCriticalTrailers"), "DD___", "•")}`,
    `Escalations Needed\n${fillInBullets(value("lsEscalations"), "__________", "•")}`,
    `Shift Health\n${fillIn("lsShiftHealth")}`,
    `Reason:\n${cleanLines(value("lsHealthReason")) || "___"}`
  ].join("\n\n");
}

function extractArcs(text, limit) {
  const arcs = [];
  lineList(text).forEach((line) => {
    const match = line.match(/DD\d{3}(?:\s+[A-Z]{2,5}\d?)?/i);
    if (match) {
      const arc = match[0].toUpperCase().replace(/\s+/g, " ");
      if (!arcs.includes(arc)) {
        arcs.push(arc);
      }
    }
  });
  return arcs.slice(0, limit);
}

function pullCounterpartFromBuilder() {
  const arcs = extractArcs(value("busyArcs"), 3);
  if (arcs.length) {
    setValue("cpBusyArcs", arcs.join("\n"));
  }
  if (cleanLines(value("downstackDetails"))) {
    setValue("cpDownstack", cleanLines(value("downstackDetails")));
  }
  const psLines = joinLines([
    value("psCase") ? `${numberValue("psCase")} PS cases remaining` : "",
    value("psTote") ? `${numberValue("psTote")} PS totes remaining` : "",
    value("psPiles") ? `${numberValue("psPiles")} PS piles remaining` : "",
    value("fluidLoadDetails")
  ]);
  if (psLines) {
    setValue("cpProblemSolve", psLines);
  }
  if (cleanLines(value("jamNotes"))) {
    setValue("cpWatchOut", cleanLines(value("jamNotes")));
  }
  const opens = lineList(value("doorsToOpen")).map((line) => (/^open\b/i.test(line) ? line : `Open ${line}`));
  if (opens.length) {
    setValue("cpSosTodo", opens.join("\n"));
  }
  const rme = cleanLines(value("pendingRme"));
  setValue("cpRme", !rme || /^none\b/i.test(rme) ? "No active RME tickets." : `Active RME: ${rme.split("\n").join("; ")}`);
  render();
}

function pullLeadershipFromBuilder() {
  if (value("smartLocksCreated")) {
    setValue("lsSmartLocks", `${value("smartLocksCreated")} created this shift`);
  } else if (value("locksUsed")) {
    setValue("lsSmartLocks", `${value("locksUsed")} used`);
  }
  if (value("truePauseLoad")) {
    setValue("lsPauseLoads", value("truePauseLoad"));
  }
  if (cleanLines(value("jamNotes"))) {
    setValue("lsRecurringIssues", cleanLines(value("jamNotes")));
  }
  const closers = lineList(value("doorsNextToClose"));
  const hot = closers.filter((line) => {
    const match = line.match(/(\d{1,3})\s*%/);
    return match && Number(match[1]) >= 85;
  });
  const critical = hot.length ? hot : closers;
  if (critical.length) {
    setValue("lsCriticalTrailers", critical.join("\n"));
  }
  render();
}

const reportBuilders = {
  full: buildReport,
  counterpart: buildCounterpartReport,
  leadership: buildLeadershipReport
};

function setTab(tabId) {
  if (!reportBuilders[tabId]) {
    tabId = "full";
  }
  activeTab = tabId;
  localStorage.setItem(activeTabKey, tabId);
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-content").forEach((panel) => {
    panel.hidden = panel.dataset.tab !== tabId;
  });
  render();
}

function saveState() {
  const state = {};
  fields.forEach((id) => {
    if (id === "captureJson") {
      return;
    }
    state[id] = value(id);
  });
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function render() {
  output.textContent = reportBuilders[activeTab]();
  saveState();
}

function restoreState() {
  const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
  fields.forEach((id) => {
    const input = field(id);
    defaults.set(id, input.value);
    if (id === "captureJson") {
      return;
    }
    if (id in saved) {
      input.value = saved[id];
    }
  });
}

function setValue(id, nextValue) {
  if (nextValue === undefined || nextValue === null) {
    return;
  }
  field(id).value = String(nextValue);
}

function formatArcRows(rows) {
  if (!Array.isArray(rows)) {
    return "";
  }
  const periodGroups = new Map();
  rows.forEach((row) => {
    const period = row.period || "";
    if (!periodGroups.has(period)) {
      periodGroups.set(period, []);
    }
    periodGroups.get(period).push(row);
  });

  if (periodGroups.size > 1 || (periodGroups.size === 1 && Array.from(periodGroups.keys())[0])) {
    return Array.from(periodGroups.entries())
      .map(([period, periodRows]) => {
        const header = period ? `${period.toUpperCase()} TOP ARCS` : "TOP ARCS";
        const lines = periodRows.map((row, index) => formatArcRow(row, index)).join("\n");
        return `${header}\n${lines}`;
      })
      .join("\n\n");
  }

  return rows
    .map(formatArcRow)
    .join("\n");
}

function formatArcRow(row, index) {
  const rank = row.rank || index + 1;
  const arc = row.arc || row.door || "UNKNOWN";
  const recircs = row.recircs !== undefined ? ` - ${row.recircs} recircs` : "";
  const average = row.averageRecircs !== undefined ? ` - avg ${Number(row.averageRecircs).toFixed(1)}` : "";
  return `${rank}. ${arc}${recircs}${average}`;
}

function formatDockflowPeriods(periods) {
  if (!Array.isArray(periods) || !periods.length) {
    return "";
  }
  return periods
    .map((period) => {
      const label = period.period || "Current period";
      return `${label.toUpperCase()} TOP 3\n${formatArcRows(period.rows || [])}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function formatSspRows(rows) {
  return rows
    .map((row) => {
      const load = row.load || row.door || "UNKNOWN";
      const type = row.loadType ? ` ${row.loadType}` : "";
      const percent = row.percent !== undefined ? ` ${row.percent}%` : "";
      const sdt = row.scheduledDepartureTime ? ` SDT:${row.scheduledDepartureTime}` : "";
      const weight = row.payloadWeight !== undefined ? ` weight:${Math.round(row.payloadWeight).toLocaleString()} lb` : "";
      const cases = row.cases !== undefined ? ` csX:${row.cases}` : "";
      const totes = row.totes !== undefined ? ` tsX:${row.totes}` : "";
      const status = row.status ? ` - ${row.status}` : "";
      return `${load}${type}${percent}${sdt}${weight}${cases}${totes}${status}`;
    })
    .join("\n");
}

function importCapture() {
  let payload;
  try {
    payload = JSON.parse(value("captureJson"));
  } catch (error) {
    importStatus.textContent = "That JSON did not parse. Copy the full capture from Tampermonkey and try again.";
    return;
  }

  const captures = normalizeCaptures(payload);
  if (!captures.length) {
    importStatus.textContent = "Capture source was not recognized.";
    return;
  }

  const importedSources = [];
  captures.forEach((capture) => {
    if (applyCapture(capture)) {
      importedSources.push(capture.source);
    }
  });

  if (!importedSources.length) {
    importStatus.textContent = "Capture source was not recognized.";
    return;
  }

  importStatus.textContent = `Imported ${Array.from(new Set(importedSources)).join(", ")} capture.`;
  render();
}

function normalizeCaptures(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload.captures)) {
    return payload.captures;
  }
  const keyedCaptures = ["dockflow", "yms", "ssp", "piles", "smartlocks"]
    .filter((source) => payload[source])
    .map((source) => ({ source, ...payload[source] }));
  if (keyedCaptures.length) {
    return keyedCaptures;
  }
  return [payload];
}

function applyCapture(payload) {
  if (payload.source === "dockflow") {
    const periodText = payload.periodsTop?.length ? formatDockflowPeriods(payload.periodsTop) : formatArcRows(payload.periodTop || []);
    if (periodText) {
      setValue("busyArcs", periodText);
    }
    const shiftParts = [];
    if (payload.shiftTop?.length) {
      shiftParts.push(`ALL SHIFT TOP 5\n${formatArcRows(payload.shiftTop)}`);
    }
    if (payload.shiftAverageTop?.length) {
      shiftParts.push(`ALL SHIFT AVERAGE TOP 5\n${formatArcRows(payload.shiftAverageTop)}`);
    }
    if (shiftParts.length) {
      setValue("allShiftArcs", shiftParts.join("\n\n"));
    }
    return true;
  } else if (payload.source === "yms") {
    const pool = payload.trailerPool || {};
    setValue("azng", pool.AZNG);
    setValue("aznu", pool.AZNU);
    setValue("hgiu", pool.HGIU);
    setValue("jbhu", pool.JBHU);
    setValue("awdja", pool.AWDJA);
    return true;
  } else if (payload.source === "ssp") {
    if (payload.loadNotes?.length) {
      setValue("sspLoadNotes", formatSspRows(payload.loadNotes));
    }
    if (payload.nextToClose?.length) {
      setValue("doorsNextToClose", payload.nextToClose.slice(0, 5).join("\n"));
    }
    return true;
  } else if (payload.source === "piles") {
    setValue("psPiles", payload.pileCount);
    setValue("fluidLoadDetails", formatPileDetails(payload));
    return true;
  } else if (payload.source === "smartlocks") {
    setValue("smartLocksCreated", payload.count);
    setValue("locksUsed", payload.count);
    setValue("smartLockNote", formatSmartLockNote(payload));
    return true;
  }
  return false;
}

function formatSmartLockNote(payload) {
  const windowText = payload.windowLabel ? ` (${payload.windowLabel})` : "";
  return `SMARTLOCKS EOS HAS BEEN POSTED IN THE CHAT\nSmartlocks created: ${payload.count || 0}${windowText}`;
}

function formatPileDetails(payload) {
  if (payload.summary) {
    const carts = payload.summary.carts || 0;
    const cages = payload.summary.cages || 0;
    const pallets = payload.summary.pallets || 0;
    return `Fluid Load: ${carts} carts, ${cages} cages, ${pallets} pallets`;
  }
  if (payload.westFluidLoad) {
    const carts = payload.westFluidLoad.carts || 0;
    const cages = payload.westFluidLoad.cages || 0;
    const pallets = payload.westFluidLoad.pallets || 0;
    return `West Fluid Load: ${carts} carts, ${cages} cages, ${pallets} pallets`;
  }
  return payload.details || "";
}

async function copyReport() {
  await navigator.clipboard.writeText(reportBuilders[activeTab]());
  copyStatus.textContent = "Copied.";
  window.setTimeout(() => {
    copyStatus.textContent = "";
  }, 1800);
}

function resetForm() {
  fields.forEach((id) => {
    field(id).value = "";
  });
  importStatus.textContent = "";
  render();
}

function clearCapture() {
  field("captureJson").value = "";
  importStatus.textContent = "";
}

restoreState();
fields.forEach((id) => {
  field(id).addEventListener("input", render);
  field(id).addEventListener("change", render);
});
document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => setTab(button.dataset.tab));
});
document.querySelector("#copyBtn").addEventListener("click", copyReport);
document.querySelector("#resetBtn").addEventListener("click", resetForm);
document.querySelector("#importCaptureBtn").addEventListener("click", importCapture);
document.querySelector("#clearCaptureBtn").addEventListener("click", clearCapture);
document.querySelector("#pullCounterpartBtn").addEventListener("click", pullCounterpartFromBuilder);
document.querySelector("#pullLeadershipBtn").addEventListener("click", pullLeadershipFromBuilder);

function makeMovable(panel, posKey) {
  if (!panel) {
    return;
  }
  const handle = panel.querySelector(".move-handle");
  if (!handle) {
    return;
  }
  let offset = JSON.parse(localStorage.getItem(posKey) || "null") || { x: 0, y: 0 };
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;

  function apply() {
    panel.style.transform = offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px)` : "";
  }
  apply();

  handle.addEventListener("pointerdown", (event) => {
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    baseX = offset.x;
    baseY = offset.y;
    panel.classList.add("dragging");
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  handle.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    offset.x = baseX + (event.clientX - startX);
    offset.y = baseY + (event.clientY - startY);
    apply();
  });

  function endDrag() {
    if (!dragging) {
      return;
    }
    dragging = false;
    panel.classList.remove("dragging");
    localStorage.setItem(posKey, JSON.stringify(offset));
  }

  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  handle.addEventListener("dblclick", () => {
    offset = { x: 0, y: 0 };
    apply();
    localStorage.removeItem(posKey);
  });
}

makeMovable(document.querySelector(".editor"), "fluidEditorPos");
makeMovable(document.querySelector(".preview"), "fluidPreviewPos");

setTab(activeTab);
