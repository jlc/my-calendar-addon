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
        } else if (typeof window.__initialProps__ === "string") {
          // String → parse it (fallback for other situations)
          props = JSON.parse(window.__initialProps__);
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

    //console.log("[fmwInit] Recovered from sessionStorage");
    onReady();
  }, 80);
};

// ── Core communication functions ────────────────────────────────────────────

// In filemakerInterface.js (global scope or top-level)

// Pending promises map – use FetchId as key
const pendingCallbacks = new Map();

// Global callback handler – make it very verbose for now
window.Fmw_Callback = function (jsonString) {
  //console.log("[Fmw_Callback] Raw:", jsonString);

  try {
    const data = JSON.parse(jsonString);
    //console.log("[Fmw_Callback] Parsed:", data);

    // Try to find FetchId in multiple possible locations (robust)
    let fetchId =
      data?.Meta?.FetchId ||
      data?.fetchId ||
      data?.FetchId ||
      data?.Meta?.fetchId;

    // If not found and there's exactly one pending request → assume it's for that one
    if (!fetchId && pendingCallbacks.size === 1) {
      fetchId = Array.from(pendingCallbacks.keys())[0];
      //console.log(
      //  "[Fmw_Callback] Fallback: single pending request → using",
      //  fetchId,
      //);
    } else if (!fetchId) {
      console.warn(
        "[Fmw_Callback] No FetchId and multiple/no pending → ignoring",
      );
      return;
    }

    if (pendingCallbacks.has(fetchId)) {
      const { resolve, reject } = pendingCallbacks.get(fetchId);
      if (data.messages?.some((m) => m.code !== "0" && m.code !== "OK")) {
        reject(new Error(`FM error: ${JSON.stringify(data.messages)}`));
      } else {
        resolve(data);
      }
      pendingCallbacks.delete(fetchId);
    } else {
      console.warn("[Fmw_Callback] No pending promise for FetchId:", fetchId);
    }
  } catch (err) {
    console.error("[Fmw_Callback] Parse failed:", err);
  }
};

// Updated sendToFileMaker – ensure Meta is set correctly
const sendToFileMaker = async (scriptName, data = {}, metaOverrides = {}) => {
  const fetchId = crypto.randomUUID(); // or Date.now().toString() + Math.random()

  const fullParam = {
    Data: data,
    Meta: {
      AddonUUID:
        window.__initialProps__?.AddonUUID ||
        "F84BA49F-913B-4818-9C3D-5CDAEC10CA6D",
      FetchId: fetchId,
      Callback: "Fmw_Callback",
      Config: config,
      ...metaOverrides,
    },
  };

  const paramJson = JSON.stringify(fullParam);
  /*console.log(
    `[sendToFileMaker] Calling ${scriptName} with FetchId:`,
    fetchId,
    "Param:",
    fullParam,
  );*/

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

const sendEvent = (dummyType, payload = {}) => {
  // dummyType not used anymore
  let paramJson = JSON.stringify(payload);

  // Remove outer quotes if quirk adds them (keep this safety)
  if (paramJson.startsWith('"') && paramJson.endsWith('"')) {
    paramJson = paramJson.slice(1, -1).replace(/\\"/g, '"');
  }

  //console.log("[sendEvent] CLEAN JSON:", paramJson);
  //console.log("[sendEvent] First 50 chars:", paramJson.substring(0, 50));

  if (window.FileMaker?.PerformScript) {
    window.FileMaker.PerformScript("FCCalendarEvents", paramJson);
  }
};

const fetchRecords = async (findRequest) => {
  try {
    /*console.log(
      "FULL FIND REQUEST BEING SENT:",
      JSON.stringify(findRequest, null, 2),
    );*/
    const response = await sendToFileMaker("FCCalendarFind", findRequest);
    //console.log("[fetchRecords] Full callback response:", response);

    // Adjust unwrapping based on what FM sends
    // From your $result: it's {response: {dataInfo, data: [...]}, messages: [...]}
    return response?.response || response || { data: [] };
  } catch (err) {
    if (err.code !== "401") {
      console.error("[fetchRecords] Failed:", err);
    }
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
    [endField]: `<${endFormatted}`, // try <= if events on end date are missing
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

  //console.log("[DEBUG] Using layout:", safeLayout);

  const findRequest = {
    layouts: safeLayout,
    query: [queryConditions],
    limit: 3000,
  };

  /*console.log(
    "[fetchEventsInRange] Correct payload:",
    JSON.stringify(findRequest, null, 2),
  );*/

  try {
    const result = await fetchRecords(findRequest);

    //console.log("[fetchEventsInRange] Full result from fetchRecords:", result);

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
  const fd = fmRecord.fieldData || {};

  //console.log("[DEBUG] Available fieldData keys:", Object.keys(fd));

  // Align exactly with your config keys (from screenshot)
  const idField = resolveFieldName("EventPrimaryKeyField") || "Id";
  const titleField = resolveFieldName("EventTitleField") || "Title";
  const startDateField = resolveFieldName("EventStartDateField") || "StartDate";
  const startTimeField = resolveFieldName("EventStartTimeField") || "StartTime";
  const endDateField = resolveFieldName("EventEndDateField") || "EndDate";
  const endTimeField = resolveFieldName("EventEndTimeField") || "EndTime";
  const allDayField = resolveFieldName("EventAllDayField") || "AllDay";
  const editableField = resolveFieldName("EventEditableField") || "Editable";
  const descriptionField =
    resolveFieldName("EventDescriptionField") || "Description";
  // Add more as needed, e.g. styleField = resolveFieldName("EventStyleField") || "Style";

  /*console.log("[DEBUG] Resolved field names:", {
    id: idField,
    title: titleField,
    startDate: startDateField,
    startTime: startTimeField,
    endDate: endDateField,
    endTime: endTimeField,
    allDay: allDayField,
    editable: editableField,
    description: descriptionField,
  });*/

  const id = fd[idField];
  if (!id) {
    console.warn("[Map] Missing ID - field not found:", idField, "in", fd);
    return null;
  }

  const title = fd[titleField] || "Untitled";

  const startDateVal = fd[startDateField];
  const startTimeVal = fd[startTimeField] || "00:00:00";
  /*console.log("[DEBUG] Start raw values:", {
    date: startDateVal,
    time: startTimeVal,
  });*/

  const start = parseFMDateTime(startDateVal, startTimeVal);
  if (!start) {
    console.warn("[Map] Invalid start date/time");
    return null;
  }

  let end;
  const endDateVal = fd[endDateField];
  const endTimeVal = fd[endTimeField] || "00:00:00";
  if (endDateVal) {
    end = parseFMDateTime(endDateVal, endTimeVal);
  } else {
    // Fallback: infer end as start +1 hour if missing
    const fallbackEnd = new Date(start);
    fallbackEnd.setHours(fallbackEnd.getHours() + 1);
    end = fallbackEnd.toISOString();
    console.log("[DEBUG] Inferred end:", end);
  }

  const allDay =
    fd[allDayField] === "1" ||
    fd[allDayField] === 1 ||
    (!startTimeVal.trim() && !endTimeVal.trim());

  const editable = fd[editableField] === 1 || fd[editableField] === "1" || true;

  /*console.log(
    `[mapRecordToEvent] SUCCESS: ID=${id}, Editable=${editable}, Start=${start}, End=${end}, AllDay=${allDay}, Title=${title}`,
    );

  console.log("[map] Full event object sent to FullCalendar:", {
    id,
    title,
    start,
    end,
    allDay,
    editable: true,
    durationEditable: true,
    startStr: new Date(start).toISOString(),
    endStr: end ? new Date(end).toISOString() : "missing",
    });*/

  return {
    id: String(id), // Ensure string for FullCalendar
    title,
    start,
    end: end || undefined,
    allDay,
    editable: editable,
    durationEditable: true,
    extendedProps: {
      description: fd[descriptionField] || "",
      // Add more: e.g. style: fd[styleField] ? JSON.parse(fd[styleField]) : null,
    },
  };
};

// Helper: Parse MM/DD/YYYY + HH:mm:ss → FullCalendar ISO string
//NEW explicit handle of MM/DD/YYYY
const parseFMDateTime = (dateStr, timeStr = "00:00:00") => {
  if (!dateStr) return null;
  //console.log("[Parse] Input:", dateStr, timeStr);

  const [month, day, year] = dateStr
    .split("/")
    .map((p) => p.trim().padStart(2, "0"));
  if (!month || !day || !year) return null;

  const [h = "00", m = "00", s = "00"] = timeStr
    .split(":")
    .map((p) => p.trim().padStart(2, "0"));

  const iso = `${year}-${month}-${day}T${h}:${m}:${s}`;
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) {
    console.warn("[parseFMDateTime] Invalid ISO:", iso);
    return null;
  }
  return dt.toISOString();
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

// ... (keep all previous code unchanged, including sendToFileMaker, fmwInit, etc.)

// Helper to send wrapped notifications (fire-and-forget)
const sendWrappedEvent = (eventType, dataPayload = {}) => {
  const fetchId = crypto.randomUUID();

  const fullParam = {
    Data: dataPayload,
    Meta: {
      EventType: eventType, // Placed in Meta to match script extraction
      AddonUUID: addonUUID || window.__initialProps__?.AddonUUID,
      FetchId: fetchId,
      Callback: "Fmw_Callback",
      Config: config, // Full config, as script may use it
    },
  };

  let paramJson = JSON.stringify(fullParam);

  // Remove outer quotes if quirk adds them
  if (paramJson.startsWith('"') && paramJson.endsWith('"')) {
    paramJson = paramJson.slice(1, -1).replace(/\\"/g, '"');
  }

  /*console.log(
    "[sendWrappedEvent] Sending for",
    eventType,
    ":",
    paramJson.substring(0, 100) + "...",
  );*/

  if (window.FileMaker?.PerformScript) {
    window.FileMaker.PerformScript("FCCalendarEvents", paramJson);
  } else {
    console.warn("[sendWrappedEvent] FileMaker.PerformScript not available");
  }
};

// Updated notify functions (complete & fixed to match script EventTypes and params)

// Event Click (already working, but consistent with wrapper)
const notifyEventClick = (event) => {
  console.log("[notifyEventClick] Event clicked:", event.id);

  const dataPayload = {
    id: event.id.toString(),
    eventDisplayLayout: getConfigField(
      "EventDetailLayout",
      "Visit Event Display",
    ),
    idFieldName: getConfigField("EventPrimaryKeyField", "Id"),
    editable: event.editable ? 1 : 0,
  };

  sendWrappedEvent("EventClick", dataPayload);
};

// View Change (uses "ViewStateChanged", send full view state in Data)
const notifyViewChange = (view) => {
  console.log("[notifyViewChange] View changed:", view.type);

  const dataPayload = {
    View: view.type, // Script stores entire Data as CurrentState
    // Add more if needed, e.g. dates: view.startStr, view.endStr
  };

  sendWrappedEvent("ViewStateChanged", dataPayload);
};

// Date Select (uses "NewEventFromSelected", send start/end as Data)
const notifyDateSelect = (info) => {
  console.log(
    "[notifyDateSelect] Date selected:",
    info.startStr,
    "to",
    info.endStr,
  );

  const dataPayload = {
    // Use EXACT key names expected by the child script
    StartDateStr: formatFMSetDate(info.startStr), // DD/MM/YYYY
    StartTimeStr: cleanTime(info.startStr.split("T")[1] || "00:00:00"),
    EndDateStr: formatFMSetDate(info.endStr),
    EndTimeStr: cleanTime(info.endStr.split("T")[1] || "00:00:00"),

    // Keep the other required keys (field names, etc.)
    startDateFieldName: getConfigField("EventStartDateField", "StartDate"),
    startTimeFieldName: getConfigField("EventStartTimeField", "StartTime"),
    endDateFieldName: getConfigField("EventEndDateField", "EndDate"),
    endTimeFieldName: getConfigField("EventEndTimeField", "EndTime"),

    eventDisplayLayout: getConfigField(
      "EventDetailLayout",
      "Visit Event Display",
    ),
    idFieldName: getConfigField("EventPrimaryKeyField", "Id"),
    editable: 1,
  };

  sendWrappedEvent("NewEventFromSelected", dataPayload);

  // Optional: force immediate refetch to see the change faster
  window.Calendar_Refresh?.();
};

// Event Drop (uses "EventDropped", send new dates/times and field names)
// Helper: Format date for FileMaker SET FIELD (DD/MM/YYYY)
const formatFMSetDate = (isoStr) => {
  if (!isoStr) return null;
  const date = new Date(isoStr);
  if (isNaN(date.getTime())) {
    console.warn("[formatFMSetDate] Invalid date:", isoStr);
    return null;
  }
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

// Helper: Clean time to HH:mm:ss only (remove offset)
const cleanTime = (timeStr) => {
  if (!timeStr) return "00:00:00";

  // Remove timezone and milliseconds
  let clean = timeStr.split("+")[0].split("Z")[0].split(".")[0];

  // Split and pad
  let [h = "00", m = "00", s = "00"] = clean.split(":");
  h = h.padStart(2, "0");
  m = m.padStart(2, "0");
  s = s.padStart(2, "0");

  return `${h}:${m}:${s}`;
};

const notifyEventDrop = (info) => {
  if (!info?.event?.id) {
    console.error("[notifyEventDrop] No event ID");
    return;
  }

  console.log("[notifyEventDrop] Event dropped:", info.event.id);

  const dataPayload = {
    id: info.event.id.toString(),
    idFieldName: getConfigField("EventPrimaryKeyField", "Id"),
    startDateFieldName: getConfigField("EventStartDateField", "StartDate"),
    startTimeFieldName: getConfigField("EventStartTimeField", "StartTime"),
    endDateFieldName: getConfigField("EventEndDateField", "EndDate"),
    endTimeFieldName: getConfigField("EventEndTimeField", "EndTime"),
    eventDisplayLayout: getConfigField(
      "EventDetailLayout",
      "Visit Event Display",
    ),

    // Dates in DD/MM/YYYY for Set Field
    newStartDate: formatFMSetDate(info.event.startStr),
    newStartTime: cleanTime(info.event.startStr.split("T")[1] || "00:00:00"),
    newEndDate: info.event.endStr ? formatFMSetDate(info.event.endStr) : null,
    newEndTime: info.event.endStr
      ? cleanTime(info.event.endStr.split("T")[1] || "00:00:00")
      : null,
  };

  sendWrappedEvent("EventDropped", dataPayload);

  // Optional: force immediate refetch to see the change faster
  window.Calendar_Refresh?.();
};

// Event Resize (uses "EventResized", send new end date/time and field names)
const notifyEventResize = (info) => {
  if (!info?.event?.id || !info?.event?.end) {
    console.warn("[notifyEventResize] Invalid resize info");
    return;
  }

  console.log(
    "[notifyEventResize] Event resized:",
    info.event.id,
    "new start:",
    info.event.startStr,
    "new end:",
    info.event.endStr,
  );

  const dataPayload = {
    id: info.event.id.toString(),
    idFieldName: getConfigField("EventPrimaryKeyField", "Id"),
    startDateFieldName: getConfigField("EventStartDateField", "StartDate"),
    startTimeFieldName: getConfigField("EventStartTimeField", "StartTime"),
    endDateFieldName: getConfigField("EventEndDateField", "EndDate"),
    endTimeFieldName: getConfigField("EventEndTimeField", "EndTime"),
    eventDisplayLayout: getConfigField(
      "EventDetailLayout",
      "Visit Event Display",
    ),

    // Send BOTH new start and new end (fixes start-resize reset)
    newStartDate: formatFMSetDate(info.event.startStr),
    newStartTime: cleanTime(info.event.startStr.split("T")[1] || "00:00:00"),
    newEndDate: formatFMSetDate(info.event.endStr),
    newEndTime: cleanTime(info.event.endStr.split("T")[1] || "00:00:00"),
  };

  sendWrappedEvent("EventResized", dataPayload);

  // Optional: force immediate refetch to see the change faster
  window.Calendar_Refresh?.();
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
