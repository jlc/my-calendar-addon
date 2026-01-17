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

// In filemakerInterface.js (global scope or top-level)

// Pending promises map – use FetchId as key
const pendingCallbacks = new Map();

// Global callback handler – make it very verbose for now
window.Fmw_Callback = function (jsonString) {
  console.log("[Fmw_Callback] Received raw string from FM:", jsonString);

  try {
    const data = JSON.parse(jsonString);
    console.log("[Fmw_Callback] Parsed data:", data);

    const fetchId = data?.FetchId || data?.fetchId || data?.Meta?.FetchId;
    if (!fetchId) {
      console.error("[Fmw_Callback] No FetchId found in payload");
      return;
    }

    console.log("[Fmw_Callback] Looking for promise with FetchId:", fetchId);
    console.log("Current pending keys:", Array.from(pendingCallbacks.keys()));

    if (pendingCallbacks.has(fetchId)) {
      const { resolve, reject } = pendingCallbacks.get(fetchId);
      console.log("[Fmw_Callback] Resolving promise for FetchId:", fetchId);

      if (data.error || data.code !== "0") {
        reject(new Error(data.error || "FM error: " + data.message));
      } else {
        resolve(data); // or data.response if you need to unwrap
      }
      pendingCallbacks.delete(fetchId);
    } else {
      console.warn(
        "[Fmw_Callback] No pending promise found for FetchId:",
        fetchId,
      );
    }
  } catch (err) {
    console.error("[Fmw_Callback] Parse or handling error:", err);
  }
};

// Updated sendToFileMaker – ensure Meta is set correctly
const sendToFileMaker = async (scriptName, data = {}, metaOverrides = {}) => {
  const fetchId = crypto.randomUUID(); // or Date.now().toString() + Math.random()

  const fullParam = {
    ...data,
    Meta: {
      AddonUUID:
        window.__initialProps__?.AddonUUID ||
        "F84BA49F-913B-4818-9C3D-5CDAEC10CA6D",
      FetchId: fetchId,
      Callback: "Fmw_Callback",
      ...metaOverrides,
    },
  };

  const paramJson = JSON.stringify(fullParam);
  console.log("[DEBUG] Final JSON string sent to FM script:", paramJson);
  console.log(
    `[sendToFileMaker] Calling ${scriptName} with FetchId:`,
    fetchId,
    "Param:",
    fullParam,
  );

  return new Promise((resolve, reject) => {
    pendingCallbacks.set(fetchId, { resolve, reject });

    if (window.FileMaker?.PerformScript) {
      window.FileMaker.PerformScript(scriptName, paramJson);
    } else {
      reject(new Error("FileMaker.PerformScript not available"));
    }

    // Timeout safeguard
    setTimeout(() => {
      if (pendingCallbacks.has(fetchId)) {
        pendingCallbacks.delete(fetchId);
        reject(new Error(`Timeout waiting for callback from ${scriptName}`));
      }
    }, 30000); // 30s – adjust if your finds are slow
  });
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
    console.log(
      "FULL FIND REQUEST BEING SENT:",
      JSON.stringify(findRequest, null, 2),
    );
    const response = await sendToFileMaker("FCCalendarFind", findRequest);
    console.log("[fetchRecords] Full callback response:", response);

    // Adjust unwrapping based on what FM sends
    // From your $result: it's {response: {dataInfo, data: [...]}, messages: [...]}
    return response?.response || response || { data: [] };
  } catch (err) {
    console.error("[fetchRecords] Failed:", err);
    return { data: [] };
  }
};

const fetchEventsInRange = async (startStr, endStr) => {
  const startDate = new Date(startStr);
  const endDate = new Date(endStr);

  // Buffer ±2 days (original addon style)
  const bufferStart = new Date(startDate);
  bufferStart.setDate(bufferStart.getDate() - 2);
  const bufferEnd = new Date(endDate);
  bufferEnd.setDate(bufferEnd.getDate() + 2);

  // Format dates in MM/DD/YYYY (the one that worked for you)
  const formatUSDate = (date) => {
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    const year = date.getFullYear();
    //return `${month}/${day}/${year}`;
    return `${year}+${month}+${day}`;
  };

  const startFormatted = formatUSDate(bufferStart);
  const endFormatted = formatUSDate(bufferEnd);

  // Resolve the REAL field names from ConfigStore (using getConfigField for .value unwrap)
  const startField = getConfigField("EventStartDateField", "StartDate");
  const endField = getConfigField("EventEndDateField", "EndDate");
  const eventDetailLayout = getConfigField("EventDetailLayout", "EventDetail"); // Adjust default if known

  const queryConditions = {
    [startField]: `>=${startFormatted}`,
    [endField]: `<=${endFormatted}`, // try <= if events on end date are missing
    // Remove hardcoded filter unless needed for your test data
    // DoctorAccountName: "dev",
  };

  const safeLayout = (eventDetailLayout || "").trim();
  if (!safeLayout) {
    console.error(
      "[fetchEventsInRange] ERROR: No layout name in config! Using fallback.",
    );
    // Optional: fallback to a known good layout
    // safeLayout = "Events";
  }

  console.log("[DEBUG] Using layout:", safeLayout);

  const findRequest = {
    action: "read",
    layouts: safeLayout,
    query: [queryConditions],
    limit: 3000,
  };

  console.log(
    "[fetchEventsInRange] Correct payload:",
    JSON.stringify(findRequest, null, 2),
  );

  try {
    const result = await fetchRecords(findRequest);

    console.log("[fetchEventsInRange] Full result from fetchRecords:", result);

    // Depending on what fetchRecords returns, unwrap appropriately
    const records = result?.response?.data || result?.data || [];

    if (!Array.isArray(records)) {
      console.warn("No valid data array in response", result);
      return [];
    }

    console.log(`[fetchEventsInRange] Received ${records.length} raw records`);

    return records;
  } catch (err) {
    console.error("[fetchEventsInRange] fetchRecords failed:", err);
    return [];
  }
};

// ── Event transformation ────────────────────────────────────────────────────
const mapRecordToEvent = (fmRecord) => {
  const fd = fmRecord.fieldData || {}; // ← THIS is the key

  // Dynamically resolve field names from config
  const idField = getConfigField("EventIdField", "Id");
  const titleField = getConfigField("EventTitleField", "Title");
  const startDateField = getConfigField("EventStartDateField", "StartDate");
  const startTimeField = getConfigField("EventStartTimeField", "StartTime");
  const endDateField = getConfigField("EventEndDateField", "EndDate");
  const endTimeField = getConfigField("EventEndTimeField", "EndTime");
  const allDayField = getConfigField("AllDayField", "AllDay");
  const descriptionField = getConfigField(
    "EventDescriptionField",
    "Description",
  );
  const editableField = getConfigField("EditableField", "Editable");
  // Add more as needed, e.g., colorField = getConfigField("EventColorField", "Color");

  const id = fd[idField];
  if (!id) {
    console.warn("Missing Id:", fd);
    return null;
  }

  const title = fd[titleField] || "Untitled";

  const start = parseFMDateTime(
    fd[startDateField],
    fd[startTimeField] || "00:00:00",
  );
  let end = parseFMDateTime(fd[endDateField], fd[endTimeField] || "00:00:00");

  const allDay =
    fd[allDayField] === 1 ||
    fd[allDayField] === "1" ||
    (!fd[startTimeField] && !fd[endTimeField]);

  if (!start) {
    console.warn(
      "Invalid start date/time:",
      fd[startDateField],
      fd[startTimeField],
    );
    return null;
  }

  // For all-day/multi-day: if no end, default to start +1 day (FullCalendar expects end-exclusive)
  if (!end && allDay) {
    end = new Date(start);
    end.setDate(end.getDate() + 1);
    end = end.toISOString();
  }

  console.log(
    `[mapRecordToEvent] Mapped event: ID=${id}, Title=${title}, Start=${start}, End=${end}, AllDay=${allDay}`,
  );

  return {
    id: id, // UUID is fine as string
    title: title,
    start: start, // must be ISO string or Date
    end: end || undefined, // optional for all-day
    allDay: allDay,
    editable: fd[editableField] === 1 || fd[editableField] === "1",
    extendedProps: {
      description: fd[descriptionField] || "",
      // style: fd.Style || "", // if JSON, parse later
      // Add more: VisitStatus, Consultants::FirstAndLastNames, etc.
    },
  };
};
// Helper: Parse MM/DD/YYYY + HH:mm:ss → FullCalendar ISO string
const parseFMDateTime = (dateStr, timeStr) => {
  if (!dateStr) return null;

  // Input: "01/15/2026" (MM/DD/YYYY)
  const [month, day, year] = dateStr.split("/").map((p) => p.trim());
  if (!month || !day || !year) return null;

  const [h = "00", m = "00", s = "00"] = timeStr
    ? timeStr.split(":").map((p) => p.trim().padStart(2, "0"))
    : ["00", "00", "00"];

  // Output ISO for FullCalendar
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

// ── Event notify ────────────────────────────────────────────────────────────
const notifyEventClick = (event) => {
  console.log("[notifyEventClick] Event clicked:", event.id);
  sendEvent("EventClick", { EventId: event.id });
};

const notifyEventDrop = (event, delta) => {
  console.log("[notifyEventDrop] Event dropped:", event.id, delta);
  sendEvent("EventDrop", { EventId: event.id, Delta: delta });
};

const notifyEventResize = (event) => {
  console.log("[notifyEventResize] Event resized:", event.id);
  sendEvent("EventResize", { EventId: event.id });
};

const notifyDateSelect = (info) => {
  console.log("[notifyDateSelect] Date selected:", info.startStr, info.endStr);
  sendEvent("DateSelect", { Start: info.startStr, End: info.endStr });
};

const notifyViewChange = (view) => {
  console.log("[notifyViewChange] View changed:", view.type);
  sendEvent("ViewChange", { View: view.type });
};

export {
  fmwInit,
  setupWindowFunctions,
  fetchEventsInRange,
  mapRecordToEvent,
  notifyEventClick,
  notifyEventDrop,
  notifyEventResize,
  notifyDateSelect,
  notifyViewChange,
  getConfigField,
  mapViewName,
  getFirstDayOfWeek,
  resolveFieldName,
};
