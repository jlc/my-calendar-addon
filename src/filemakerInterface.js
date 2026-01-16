// src/filemakerInterface.js
// Updated for exact ConfigStore.json / CurrentState.json handling (Jan 2026 version)
// 100% compatible with existing FileMaker web viewer and scripts

import { v4 as uuidv4 } from "uuid";

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 30000; // TODO: should be 30000
const CALLBACK_FUNCTION_NAME = "Fmw_Callback";
const SESSION_STATE_KEY = "calendar.state";
const SESSION_CONFIG_KEY = "calendar.config";

// ── Globals ─────────────────────────────────────────────────────────────────
let addonUUID = null;
let config = {};
let callbackRegistry = {}; // fetchId → { resolve, reject, timeoutId, status }

// ── Helpers ─────────────────────────────────────────────────────────────────
const isInFileMaker = () => !!window.FileMaker;

const getSessionItem = (key) => {
  try {
    const value = sessionStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

const setSessionItem = (key, value) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn("SessionStorage write failed:", err);
  }
};

// Get config value (handles { type, value } structure from ConfigStore)
const getConfigField = (key, defaultValue = null) => {
  return config?.[key]?.value ?? defaultValue;
};

// Resolve field name (strips "Table::" prefix, like original)
const resolveFieldName = (configKey) => {
  const fullRef = getConfigField(configKey, configKey);
  return fullRef?.split("::")?.[1] || fullRef || configKey;
};

// Map user-friendly view names to FullCalendar views
const mapViewName = (viewName) => {
  const mappings = {
    Month: "dayGridMonth",
    Week: "timeGridWeek",
    Day: "timeGridDay",
    List: "listWeek", // Adjust if needed
  };
  return mappings[viewName] || viewName; // Fallback to raw if unknown
};

// Get first day of week (0=Sunday, 1=Monday, etc.)
const getFirstDayOfWeek = () => {
  const startOn = getConfigField("StartOnDay", "Sunday");
  return startOn === "Monday" ? 1 : 0;
};

// ── Initialization ──────────────────────────────────────────────────────────
const fmwInit = (onReady = () => {}) => {
  if (addonUUID) {
    onReady();
    return;
  }

  const pollForFileMaker = setInterval(() => {
    if (!window.FileMaker) return;

    clearInterval(pollForFileMaker);

    let initialState = {};

    // 1. Try from injected __initialProps__ (primary source)
    if (window.__initialProps__) {
      try {
        let props;

        // ── IMPORTANT CHANGE HERE ─────────────────────────────────────────
        if (
          typeof window.__initialProps__ === "object" &&
          window.__initialProps__ !== null
        ) {
          // Already an object → use directly (current successful case)
          props = window.__initialProps__;
          console.log("[fmwInit] Using already-parsed object for props");
        } else if (typeof window.__initialProps__ === "string") {
          // String → parse it (fallback for other situations)
          props = JSON.parse(window.__initialProps__);
          console.log("[fmwInit] Parsed string to object");
        } else {
          throw new Error("Unexpected type for __initialProps__");
        }
        // ─────────────────────────────────────────────────────────────────

        addonUUID = props.AddonUUID || uuidv4();
        config = props.Config || {};
        initialState = props.State || {};

        setSessionItem(SESSION_CONFIG_KEY, config);
        setSessionItem(SESSION_STATE_KEY, initialState);

        console.log(
          "[fmwInit] Initialized successfully - Config keys:",
          Object.keys(config),
        );

        onReady();
        return;
      } catch (err) {
        console.error("[fmwInit] Failed processing __initialProps__:", err);
      }
    }

    // 2. Fallback: recover from sessionStorage
    config = getSessionItem(SESSION_CONFIG_KEY) || {};
    initialState = getSessionItem(SESSION_STATE_KEY) || {};
    addonUUID = initialState.AddonUUID || uuidv4();

    console.log("[fmwInit] Recovered from sessionStorage");
    onReady();
  }, 80);
};

// ── Core communication functions ────────────────────────────────────────────
const generateFetchId = () => uuidv4();

const sendToFileMaker = (
  scriptName,
  data = {},
  metaOverrides = {},
  withCallback = true,
) => {
  if (!isInFileMaker()) {
    console.warn(
      `[FM] Not in FileMaker context - call to ${scriptName} skipped`,
    );
    return Promise.resolve(null);
  }

  const fetchId = generateFetchId();

  const meta = {
    Config: config,
    AddonUUID: addonUUID,
    ...(withCallback
      ? { FetchId: fetchId, Callback: CALLBACK_FUNCTION_NAME }
      : {}),
    ...metaOverrides,
  };

  const payload = {
    Data: data,
    Meta: meta,
  };

  const jsonPayload = JSON.stringify(payload);

  if (withCallback) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        delete callbackRegistry[fetchId];
        reject(new Error(`Timeout after ${DEFAULT_TIMEOUT_MS}ms`));
      }, DEFAULT_TIMEOUT_MS);

      callbackRegistry[fetchId] = {
        resolve,
        reject,
        timeoutId,
        status: "pending",
      };

      window.FileMaker.PerformScript(scriptName, jsonPayload);
    });
  } else {
    window.FileMaker.PerformScript(scriptName, jsonPayload);
    return Promise.resolve(null);
  }
};

// ── Callback handler ────────────────────────────────────────────────────────
window.Fmw_Callback = (responseJson, fetchId) => {
  const entry = callbackRegistry[fetchId];

  if (!entry || entry.status !== "pending") {
    console.warn(`Late or unknown callback for fetchId: ${fetchId}`);
    return;
  }

  try {
    const result = JSON.parse(responseJson);
    entry.resolve(result);
  } catch (err) {
    console.error("Callback parsing error:", err);
    entry.reject(err);
  } finally {
    clearTimeout(entry.timeoutId);
    delete callbackRegistry[fetchId];
  }
};

// ── High-level API ──────────────────────────────────────────────────────────
const sendEvent = (eventType, payload = {}) => {
  return sendToFileMaker(
    "FCCalendarEvents",
    { ...payload, EventType: eventType },
    {},
    false,
  );
};

const fetchRecords = async (findRequest) => {
  try {
    const result = await sendToFileMaker("FCCalendarFind", findRequest);
    return result?.data || [];
  } catch (err) {
    console.error("Find failed:", err);
    return [];
  }
};

const fetchEventsInRange = async (startStr, endStr) => {
  const start = new Date(startStr);
  const end = new Date(endStr);

  // ±2 day buffer
  start.setDate(start.getDate() - 2);
  end.setDate(end.getDate() + 2);

  // US MM/DD/YYYY format – test this first to bypass validation quirk
  const formatUSDate = (date) => {
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    const year = date.getFullYear();
    return `${month}/${day}/${year}`;
  };

  const startFormatted = formatUSDate(start); // e.g. "12/21/2025"
  const endFormatted = formatUSDate(end); // e.g. "02/13/2026"

  const startField = resolveFieldName("EventStartDateField");
  const endField = resolveFieldName("EventEndDateField");

  const queryConditions = {
    [startField]: `>=${startFormatted}`,
    [endField]: `<${endFormatted}`, // try <= if events on end date are missing
  };

  // Your active filter
  queryConditions.DoctorAccountName = "dev";

  const findRequest = {
    //layouts: resolveFieldName("EventDetailLayout") || "Visits", // adjust fallback
    layouts: "Visit Event Display", // hardcode for now or use config
    query: [queryConditions],
    limit: 3000,
  };

  console.log(
    "[fetchEventsInRange] US format find request:",
    JSON.stringify(findRequest, null, 2),
  );

  try {
    const rawResult = await fetchRecords(findRequest);
    console.log("[fetchEventsInRange] Raw result:", rawResult);

    // Adjust based on your wrapper — aim for array of records
    const records = rawResult?.response?.data || rawResult?.data || [];
    console.log(`[fetchEventsInRange] ${records.length} raw records received`);

    return records;
  } catch (err) {
    console.error(err);
    return [];
  }
};

// ── Event transformation ────────────────────────────────────────────────────
const mapRecordToEvent = (fmRecord) => {
  const fd = fmRecord.fieldData || {}; // ← THIS is the key

  // Use the actual field names from your returned data + config
  const id = fd.Id; // UUID string
  const title = fd.Title || "Untitled";
  const startDate = fd.StartDate;
  const startTime = fd.StartTime || "00:00:00";
  const endDate = fd.EndDate;
  const endTime = fd.EndTime || "00:00:00";
  const allDay = fd.AllDay === 1 || fd.AllDay === "1";

  if (!id || !startDate) return null;

  const start = parseFMDateTime(startDate, startTime);
  const end = parseFMDateTime(endDate, endTime);

  if (!start) return null;

  return {
    id: id, // UUID is fine as string
    title: title,
    start: start, // must be ISO string or Date
    end: end || undefined, // optional for all-day
    allDay: allDay,
    editable: fd.Editable === 1 || fd.Editable === "1",
    extendedProps: {
      description: fd.Description || "",
      style: fd.Style || "", // if JSON, parse later
      // You can add more: VisitStatus, Consultants::FirstAndLastNames, etc.
    },
  };
};

// Helper: Parse MM/DD/YYYY + HH:mm:ss → FullCalendar ISO string
const parseFMDateTime = (dateStr, timeStr) => {
  if (!dateStr) return null;

  const [month, day, year] = dateStr.split("/").map((p) => p.trim());
  if (!month || !day || !year) return null;

  const [hours, minutes, seconds = "00"] = timeStr
    .split(":")
    .map((p) => p.trim());

  // Build ISO: YYYY-MM-DDTHH:mm:ss
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hours}:${minutes}:${seconds}`;
};

// ── Calendar controls ───────────────────────────────────────────────────────
const setupWindowFunctions = (calendarRef) => {
  const api = () => calendarRef.current?.getApi();

  window.Calendar_Refresh = () => api()?.refetchEvents();
  window.Calendar_SetView = (viewName) =>
    api()?.changeView(mapViewName(viewName));
  window.Calendar_Next = () => api()?.next();
  window.Calendar_Prev = () => api()?.prev();
  window.Calendar_Today = () => api()?.today();
  window.Calendar_GotoDate = (dateStr) => {
    if (dateStr) api()?.gotoDate(dateStr);
  };

  window.fmwGetState = () => ({
    addonUUID,
    config,
    sessionState: getSessionItem(SESSION_STATE_KEY),
  });
};

// ── Event notify handlers ───────────────────────────────────────────────────
const notifyEventClick = (event) =>
  sendEvent("EventClick", { EventID: event.id });

const notifyEventDrop = (event, delta) =>
  sendEvent("EventDropped", {
    EventID: event.id,
    NewStart: event.start.toISOString(),
    NewEnd: event.end?.toISOString(),
    DeltaDays: delta?.days,
    DeltaMs: delta?.milliseconds,
  });

const notifyEventResize = (event) =>
  sendEvent("EventResized", {
    EventID: event.id,
    NewStart: event.start.toISOString(),
    NewEnd: event.end?.toISOString(),
  });

const notifyDateSelect = (selection) =>
  sendEvent("NewEventFromSelected", {
    Start: selection.start.toISOString(),
    End: selection.end.toISOString(),
    AllDay: selection.allDay,
  });

let lastViewChangeTime = 0;
const notifyViewChange = (view) => {
  const now = Date.now();
  if (now - lastViewChangeTime < 1000) {
    // 1 second cooldown
    console.log("[ViewChange] Skipped - too soon");
    return;
  }
  lastViewChangeTime = now;

  const state = {
    type: view.type,
    title: view.title,
    activeStart: view.activeStart.toISOString(),
    activeEnd: view.activeEnd.toISOString(),
    currentStart: view.currentStart.toISOString(),
    currentEnd: view.currentEnd.toISOString(),
    calendarDate: view.calendar.getDate().toISOString(),
    currentDate: new Date().toISOString(),
  };

  // Add this guard to avoid loop if state hasn't changed
  const prevState = getSessionItem(SESSION_STATE_KEY);
  if (JSON.stringify(state) === JSON.stringify(prevState)) {
    console.log("[ViewChange] State unchanged - skipping send");
    return;
  }

  setSessionItem(SESSION_STATE_KEY, state); // Persist like CurrentState.json
  sendEvent("ViewStateChanged", state);
};

// ── All exports (named only - no duplicates) ────────────────────────────────
export {
  fmwInit,
  setupWindowFunctions,
  fetchEventsInRange,
  mapRecordToEvent,
  sendEvent,
  notifyEventClick,
  notifyEventDrop,
  notifyEventResize,
  notifyDateSelect,
  notifyViewChange,
  getConfigField,
  resolveFieldName,
  mapViewName,
  getFirstDayOfWeek,
};
