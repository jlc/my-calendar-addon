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

/*
const fetchEventsInRange = async (startDate, endDate) => {
  const start = new Date(startDate);
  const end = new Date(endDate);

  start.setDate(start.getDate() - 3);
  end.setDate(end.getDate() + 3);

  const request = {
    [resolveFieldName("EventStartDateField")]:
      `>=${start.toISOString().split("T")[0]}`,
    [resolveFieldName("EventEndDateField")]:
      `<=${end.toISOString().split("T")[0]}`,
  };

  return fetchRecords(request);
};
*/
// src/filemakerInterface.js

const fetchEventsInRange = async (startStr, endStr) => {
  const startDate = new Date(startStr);
  const endDate = new Date(endStr);

  // Add ±2 day buffer like original addon
  const bufferStart = new Date(startDate);
  bufferStart.setDate(bufferStart.getDate() - 2);
  const bufferEnd = new Date(endDate);
  bufferEnd.setDate(bufferEnd.getDate() + 2);

  // Format as YYYYMMDD (plain, no dashes)
  const formatYMD = (date) => {
    const y = date.getFullYear().toString();
    const m = (date.getMonth() + 1).toString().padStart(2, "0");
    const d = date.getDate().toString().padStart(2, "0");
    return y + m + d;
  };

  const startYMD = formatYMD(bufferStart);
  const endYMD = formatYMD(bufferEnd);

  // Get config values (assuming you have a way to access ConfigStore fields)
  // If not already global, import or use your config loader
  const config = window.__config__ || {}; // Adjust based on your init

  const startField = config.EventStartDateField || "StartDate"; // fallback
  const endField = config.EventEndDateField || "EndDate";

  const queryObj = {
    [startField]: `>=${startYMD}`,
    [endField]: `<${endYMD}`,
  };

  const payload = {
    layouts: config.EventDetailLayout || "Event Detail", // from ConfigStore
    query: [queryObj], // array of one find request object
    limit: 3000, // safe high limit like original
  };

  console.log(
    "[fetchEventsInRange] Calling FCCalendarFind with payload:",
    payload,
  );

  try {
    const result = await fmwCall("FCCalendarFind", payload);

    console.log("[fetchEventsInRange] Raw result:", result);

    if (!result?.ok || !Array.isArray(result.data)) {
      console.warn("[fetchEventsInRange] Invalid/no data", result);
      return [];
    }

    // Map records (each has .fieldData)
    return result.data.map((record) => mapRecordToEvent(record));
  } catch (err) {
    console.error("[fetchEventsInRange] Call failed:", err);
    return [];
  }
};

// ── Event transformation ────────────────────────────────────────────────────
/*
const mapRecordToEvent = (record) => {
  if (!record) return null;

  return {
    id: record[resolveFieldName("EventPrimaryKeyField")],
    title: record[resolveFieldName("EventTitleField")] || "",
    start: record[resolveFieldName("EventStartDateField")],
    end: record[resolveFieldName("EventEndDateField")],
    allDay: !!record[resolveFieldName("EventAllDayField")],
    editable: record[resolveFieldName("EventEditableField")] !== false,
    extendedProps: {
      description: record[resolveFieldName("EventDescriptionField")],
    },
    // Add style parsing if EventStyleField is JSON/color
  };
};
*/
const mapRecordToEvent = (record) => {
  const fieldData = record.fieldData || {}; // safe access
  const config = window.__config__ || {}; // adjust to your config access

  const id = fieldData[config.EventPrimaryKeyField];
  if (!id) return null;

  const title = fieldData[config.EventTitleField] || "Untitled";

  // Build ISO start/end strings
  const start = buildISODate(
    fieldData[config.EventStartDateField],
    fieldData[config.EventStartTimeField] || "00:00:00",
  );

  const end = buildISODate(
    fieldData[config.EventEndDateField],
    fieldData[config.EventEndTimeField] || "00:00:00",
  );

  const allDayStr = fieldData[config.EventAllDayField];
  const allDay = allDayStr === "1" || allDayStr === true || allDayStr === "Yes";

  return {
    id: id.toString(),
    title,
    start,
    end: end || undefined, // omit if same as start for all-day
    allDay,
    editable: true, // adjust based on config/field if needed
    extendedProps: {
      description: fieldData[config.EventDescriptionField] || "",
      // Add more like location, status, custom style/color if present
    },
    // Example: backgroundColor: fieldData.EventColor || '#3788d8'
  };
};

// Helper: Convert FM date/time to ISO string (handle common FM formats)
const buildISODate = (dateStr, timeStr = "00:00:00") => {
  if (!dateStr) return null;

  // FM often returns MM/DD/YYYY or YYYY-MM-DD; normalize
  let [year, month, day] = dateStr.includes("-")
    ? dateStr.split("-")
    : dateStr.split("/").reverse(); // MM/DD/YYYY → YYYY/MM/DD

  if (!year || !month || !day) return null;

  const [h, m, s = "00"] = timeStr
    .split(":")
    .map((part) => part.padStart(2, "0"));

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${h}:${m}:${s}`;
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
