// filemakerInterface.js

import { v4 as uuidv4 } from "uuid";

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 30000;
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
    List: "listWeek",
    Year: "multiMonthYear",
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
        if (typeof window.__initialProps__ === "object" && window.__initialProps__ !== null) {
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

        console.log("[filemakerInterface.fmwInit] Initialized successfully.");

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
    let fetchId = data?.Meta?.FetchId || data?.fetchId || data?.FetchId || data?.Meta?.fetchId;

    // If not found and there's exactly one pending request → assume it's for that one
    if (!fetchId && pendingCallbacks.size === 1) {
      fetchId = Array.from(pendingCallbacks.keys())[0];
      //console.log(
      //  "[Fmw_Callback] Fallback: single pending request → using",
      //  fetchId,
      //);
    } else if (!fetchId) {
      console.warn("[Fmw_Callback] No FetchId and multiple/no pending → ignoring");
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
      AddonUUID: window.__initialProps__?.AddonUUID || "F84BA49F-913B-4818-9C3D-5CDAEC10CA6D",
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
    const response = await sendToFileMaker("FCCalendarFind", findRequest);
    //console.log("[fetchRecords] Full callback response:", response);

    const result = response?.response || response || {};
    const messages = Array.isArray(response?.messages) ? response.messages : [];

    // Handle 401 inside try (if promise resolves with error)
    if (messages.some((msg) => msg?.code === "401" || msg?.code === 401)) {
      console.log("[fetchRecords] No records found (401 in messages) - returning empty array");
      return { dataInfo: {}, data: [] };
    }

    // Check for other error codes in messages
    const errorMsg = messages.find(
      (msg) => msg?.code !== "0" && msg?.code !== "401" && msg?.code !== 0,
    );
    if (errorMsg) {
      console.error("[fetchRecords] FM returned non-401 error:", errorMsg);
      return { dataInfo: {}, data: [] };
    }

    // Success case
    return {
      dataInfo: result.dataInfo || {},
      data: result.data || [],
    };
  } catch (err) {
    // Handle 401 inside catch (if promise rejects on 401)
    if (
      err?.message?.includes("401") ||
      err?.message?.includes("No records match the request") ||
      err?.code === "401" ||
      err?.response?.messages?.some?.((msg) => msg?.code === "401" || msg?.code === 401)
    ) {
      /*console.log(
        "[fetchRecords] No records found (401 in catch) - returning empty array",
      );*/
      return { dataInfo: {}, data: [] };
    }

    // Real errors (network, timeout, etc.) - log in red
    console.error("[fetchRecords] Real failure (not 401):", err);
    return { dataInfo: {}, data: [] };
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

  // Format dates in MM/DD/YYYY for FM Execute Data API (required format for queries, regardless of locale)
  const formatUSDate = (date) => {
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    const year = date.getFullYear();
    return `${month}/${day}/${year}`;
  };

  const startFormatted = formatUSDate(bufferStart);
  const endFormatted = formatUSDate(bufferEnd);

  const startField = getConfigField("EventStartDateField", "StartDate");
  const endField = getConfigField("EventEndDateField", "EndDate");
  const eventDetailLayout = getConfigField("EventDetailLayout", "EventDetail");

  const queryConditions = {
    [startField]: `>=${startFormatted}`,
    [endField]: `<${endFormatted}`,
  };

  const safeLayout = (eventDetailLayout || "").trim();
  if (!safeLayout) {
    console.error("[fetchEventsInRange] ERROR: No layout name in config! Using fallback.");
    // Optional: fallback to a known good layout
    // safeLayout = "Events";
  }

  //console.log("[DEBUG] Using layout:", safeLayout);

  const findRequest = {
    layouts: safeLayout,
    query: [queryConditions],
    limit: 3000,
  };

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
// Called by FM FCCalendarFind with result from FM (the records date/time use US format, not file locale)
const mapRecordToEvent = (fmRecord) => {
  const fd = fmRecord.fieldData || {};

  //console.log("[DEBUG] Available fieldData keys:", Object.keys(fd));

  const idField = resolveFieldName("EventPrimaryKeyField") || "Id";
  const titleField = resolveFieldName("EventTitleField") || "Title";
  const startDateField = resolveFieldName("EventStartDateField") || "StartDate";
  const startTimeField = resolveFieldName("EventStartTimeField") || "StartTime";
  const endDateField = resolveFieldName("EventEndDateField") || "EndDate";
  const endTimeField = resolveFieldName("EventEndTimeField") || "EndTime";
  const allDayField = resolveFieldName("EventAllDayField") || "AllDay";
  const editableField = resolveFieldName("EventEditableField") || "Editable";
  const descriptionField = resolveFieldName("EventDescriptionField") || "Description";
  const styleField = resolveFieldName("EventStyleField") || "Style";

  const id = fd[idField];
  if (!id) {
    console.warn("[mapRecordToEvent] Missing ID - field not found:", idField, "in", fd);
    return null;
  }

  //console.log("[mapRecordToEvent] fd: ", fd);

  const title = fd[titleField] || "Untitled";

  const startDateVal = fd[startDateField];
  const startTimeVal = fd[startTimeField] || "00:00:00";
  /*console.log("[DEBUG] Start raw values:", {
    date: startDateVal,
    time: startTimeVal,
  });*/

  const start = parseFMDateTime(startDateVal, startTimeVal);
  if (!start) {
    console.warn("[mapRecordToEvent] Invalid start date/time");
    return null;
  }

  let end;
  const endDateVal = fd[endDateField];
  const endTimeVal = fd[endTimeField] || "00:00:00";
  if (endDateVal) {
    end = parseFMDateTime(endDateVal, endTimeVal);
  } else {
    // Fallback: infer end as start +1 hour if missing
    end = new Date(start);
    end.setHours(end.getHours() + 1);
    end = end.toISOString();
    console.log("[DEBUG] [mapRecordToEvent] Inferred end time of event:", end);
  }

  const allDay =
    fd[allDayField] === "1" ||
    fd[allDayField] === 1 ||
    (!startTimeVal.trim() && !endTimeVal.trim());

  // Add style mapping
  const rawStyle = fd[styleField] || "-";
  const styleClass = `fc-event-${rawStyle.toLowerCase().replace(/\s+/g, "-")}`;

  /* console.log(
    `[mapRecordToEvent] SUCCESS: ID=${id}, Title=${title}, Start=${start}, End=${end}, AllDay=${allDay}`,
  ); */

  return {
    id: String(id),
    title,
    start: start,
    end: end || undefined,
    allDay: allDay,
    editable: fd[editableField] === "1" || 1,
    extendedProps: {
      description: fd[descriptionField] || "",
    },
    classNames: [styleClass], // ← Apply the CSS class for color/styling
  };
};

// ── Parse FM Date/Time ─────────────────────────────────────────────────────
// NEEDED 'CAUSE Execute Filemaker Data API' work with US dates.
const parseFMDateTime = (dateStr, timeStr = "00:00:00") => {
  if (!dateStr) return new Date();

  // Execute Filemaker Data API returns MM/DD/YYYY
  const parts = dateStr.split("/");
  if (parts.length !== 3) return new Date();

  const month = parseInt(parts[0], 10) - 1; // 0-indexed
  const day = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);

  const timeParts = timeStr.split(":");
  const hour = parseInt(timeParts[0] || "00", 10);
  const min = parseInt(timeParts[1] || "00", 10);
  const sec = parseInt(timeParts[2] || "00", 10);

  return new Date(year, month, day, hour, min, sec);
};

// ── Calendar controls ───────────────────────────────────────────────────────
const setupWindowFunctions = (calendarRef) => {
  const api = () => calendarRef.current?.getApi();

  window.Calendar_Refresh = () => {
    console.log("[Calendar_Refresh] Refreshing calendar.");

    // Clear lingering selection mirror (deep blue square)
    api()?.unselect();

    // Refetch events to reflect FM updates (auto end time, etc.)
    api()?.refetchEvents();

    // Optional: Force full visual refresh (safe if refetch alone doesn't clear)
    api()?.render();
  };
  window.Calendar_SetView = (viewName) => api()?.changeView(mapViewName(viewName));
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

// Helper to send wrapped notifications (fire-and-forget)
const sendWrappedEvent = (eventType, dataPayload = {}) => {
  const fetchId = crypto.randomUUID();

  const fullParam = {
    Data: dataPayload,
    Meta: {
      EventType: eventType,
      AddonUUID: addonUUID || window.__initialProps__?.AddonUUID,
      FetchId: fetchId,
      Callback: "Fmw_Callback",
      Config: config,
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
    eventDisplayLayout: getConfigField("EventDetailLayout", "Visit Event Display"),
    idFieldName: getConfigField("EventPrimaryKeyField", "Id"),
    editable: event.editable ? 1 : 0,
  };

  sendWrappedEvent("EventClick", dataPayload);
};

// View Change (uses "ViewStateChanged", send full view state in Data)
const notifyViewChange = (view) => {
  console.log("[notifyViewChange] View changed:", view.type);

  // Calculate calendarDate (middle of the active range)
  const start = view.activeStart;
  const end = view.activeEnd;
  const calendarDate = new Date((start.getTime() + end.getTime()) / 2);

  const dataPayload = {
    type: view.type, // "timeGridWeek", etc.
    title: view.title, // e.g. "Jan 12 – 18, 2026"
    currentStart: view.currentStart.toISOString(),
    currentEnd: view.currentEnd.toISOString(),
    activeStart: view.activeStart.toISOString(),
    activeEnd: view.activeEnd.toISOString(),
    calendarDate: calendarDate.toISOString(), // Calculated middle date
    currentDate: new Date().toISOString(), // Real-time current date
  };

  sendWrappedEvent("ViewStateChanged", dataPayload);
};

/* USE THE LAST EVENT END TIME to adjust the startime of the new one */
const notifyDateSelect = (info, calendarRef) => {
  console.log("[notifyDateSelect] Date selected:", info.startStr, "to", info.endStr);

  // Use local Date objects
  let adjustedStart = new Date(info.start);
  let adjustedEnd = new Date(info.end);

  const calendarApi = calendarRef?.current?.getApi();
  if (calendarApi) {
    const allEvents = calendarApi.getEvents();

    console.log("[notifyDateSelect] All events on day:", allEvents.length);

    // Filter same-day, non-all-day events that end within the clicked slot (overlap or middle end)
    const endingInSlotEvents = allEvents.filter((event) => {
      const sameDay = new Date(event.start).toDateString() === adjustedStart.toDateString();
      const endsInSlot = event.end > adjustedStart && event.end < adjustedEnd; // Ends after slot start and before slot end
      const isAllDay = event.allDay;

      /* console.log(
        "[notifyDateSelect] Checking event:",
        event.id,
        "sameDay:",
        sameDay,
        "endsInSlot:",
        endsInSlot,
        "allDay:",
        isAllDay,
        "event.end:",
        event.end.toISOString(),
        "adjustedStart:",
        adjustedStart.toISOString(),
        "adjustedEnd:",
        adjustedEnd.toISOString(),
      ); */

      return sameDay && !isAllDay && endsInSlot;
    });

    if (endingInSlotEvents.length > 0) {
      // Snap to the latest-ending event in the slot
      const previousEvent = endingInSlotEvents.sort((a, b) => b.end - a.end)[0];

      console.log(
        "[notifyDateSelect] Ending in slot found, snapping start to:",
        previousEvent.end.toLocaleString(),
      );

      adjustedStart = new Date(previousEvent.end.getTime());
    } else {
      console.log("[notifyDateSelect] No event ending in slot - using slot start");
    }
  }

  // 60-minute duration
  adjustedEnd = new Date(adjustedStart.getTime() + 60 * 60 * 1000);

  const locale = getConfigField("Locale", "en");

  const startDateStr = adjustedStart.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const startTimeStr = adjustedStart.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const endDateStr = adjustedEnd.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const endTimeStr = adjustedEnd.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const dataPayload = {
    StartDateStr: startDateStr,
    StartTimeStr: startTimeStr,
    EndDateStr: endDateStr,
    EndTimeStr: endTimeStr,

    startDateFieldName: getConfigField("EventStartDateField", "StartDate"),
    startTimeFieldName: getConfigField("EventStartTimeField", "StartTime"),
    endDateFieldName: getConfigField("EventEndDateField", "EndDate"),
    endTimeFieldName: getConfigField("EventEndTimeField", "EndTime"),

    eventDisplayLayout: getConfigField("EventDetailLayout", "Visit Event Display"),
    idFieldName: getConfigField("EventPrimaryKeyField", "Id"),
    editable: 1,
  };

  window.Calendar_Refresh?.();

  sendWrappedEvent("NewEventFromSelected", dataPayload);
};

const notifyEventDrop = (info) => {
  if (!info?.event?.id) {
    console.error("[notifyEventDrop] No event ID");
    return;
  }

  console.log("[notifyEventDrop] Event dropped:", info.event.id);

  // Use local Date objects
  let adjustedStart = info.event.start;
  let adjustedEnd = info.event.end;

  const locale = getConfigField("Locale", "en");

  const dataPayload = {
    id: info.event.id.toString(),
    idFieldName: getConfigField("EventPrimaryKeyField", "Id"),
    startDateFieldName: getConfigField("EventStartDateField", "StartDate"),
    startTimeFieldName: getConfigField("EventStartTimeField", "StartTime"),
    endDateFieldName: getConfigField("EventEndDateField", "EndDate"),
    endTimeFieldName: getConfigField("EventEndTimeField", "EndTime"),
    eventDisplayLayout: getConfigField("EventDetailLayout", "Visit Event Display"),

    newStartDate: adjustedStart.toLocaleDateString(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }),
    newStartTime: adjustedStart.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
    newEndDate: info.event.endStr
      ? adjustedEnd.toLocaleDateString(locale, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })
      : null,
    newEndTime: info.event.endStr
      ? adjustedEnd.toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
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

  // Use local Date objects
  let adjustedStart = info.event.start;
  let adjustedEnd = info.event.end;

  const locale = getConfigField("Locale", "en");

  const dataPayload = {
    id: info.event.id.toString(),
    idFieldName: getConfigField("EventPrimaryKeyField", "Id"),
    startDateFieldName: getConfigField("EventStartDateField", "StartDate"),
    startTimeFieldName: getConfigField("EventStartTimeField", "StartTime"),
    endDateFieldName: getConfigField("EventEndDateField", "EndDate"),
    endTimeFieldName: getConfigField("EventEndTimeField", "EndTime"),
    eventDisplayLayout: getConfigField("EventDetailLayout", "Visit Event Display"),

    newStartDate: adjustedStart.toLocaleDateString(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }),
    newStartTime: adjustedStart.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
    newEndDate: adjustedEnd.toLocaleDateString(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }),
    newEndTime: adjustedEnd.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
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

// ---------------------------------------------------------------------------------------
