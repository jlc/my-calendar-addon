// filemakerInterface.js

// ----------------------------------------
// ----------------------------------------
// TO KNOW:
//
//         FM             JAVASCRIPT
//                      notify*() -> sendWrappedEvent()
//  FCCalendarEvents <----------------------|
//     |
//     |----------------> fm-Gofer temporary function -> promise -> OK (except timeout)
//
//
//
//         FM             JAVASCRIPT
//                    FullCalendar.events -> debounced -> App.rawFetch() -> fetchEventInRange() -> fetchRecords() -> sendToFileMaker()
//     FCCalendarFind  <-----------------------------------------------------------------------------------------------------|
//            |
//            |---------------- fm-Goffer temporary function -> promise -> payload
//
//
//         FM             JAVASCRIPT
//               ----------> Window.Calendar_Next ; Calendar_Prev ; Calendar_Today ; Calendar_Refresh
//
//
// ----------------------------------------
//

import FMGofer from "fm-gofer";
import debounce from "lodash.debounce";

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_DEBOUNCE_TIME_MS = 500; // shorter -> more reactive

// ── Globals ─────────────────────────────────────────────────────────────────
let addonUUID = null;
let config = {};
//let initialState = {};
let callbackRegistry = {}; // fetchId → { resolve, reject, timeoutId, status }

// ── Helpers ─────────────────────────────────────────────────────────────────
const isInFileMaker = () => !!window.FileMaker;

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
  //console.log("FileMakerInterface.fmwInit: start");

  if (addonUUID) {
    onReady();
    return;
  }

  const pollForFileMaker = setInterval(() => {
    if (!window.FileMaker) return;

    //console.log("filemakerInterface.fmwInit.pollForFileMaker()");

    clearInterval(pollForFileMaker);

    let props;

    if (typeof window.__initialProps__ === "object" && window.__initialProps__ !== null) {
      // Already an object → use directly (current successful case)
      props = window.__initialProps__;
    } else if (typeof window.__initialProps__ === "string") {
      // String → parse it (fallback for other situations)
      //props = JSON.parse(window.__initialProps__);
      console.error(
        "fmwInit.pollForFileMaker: __initialProps__ is a string, so... Initialization did not happened!?!",
      );
      return;
    } else {
      console.error("fmwInit.pollForFileMaker: null or unexpected type for __initialProps__");
      return;
    }

    addonUUID = props.AddonUUID;
    config = props.Config || {};
    //console.log("props: ", props);
    //initialState = props.State || {};

    //console.log("filemakerInterface.fmwInit.pollForFileMaker() calling onReady()");
    onReady();
    return;
  }, 80);
};

// ── Calendar controls ───────────────────────────────────────────────────────
const setupWindowFunctions = (calendarRef) => {
  const api = () => calendarRef.current?.getApi();

  window.Calendar_Refresh = () => {
    console.log("[Calendar_Refresh] Refreshing calendar.");

    // // Clear lingering selection mirror (deep blue square)
    // BUT: called here, refresh() is called frequently and the hover does not work (without pressing Option)
    api()?.unselect();

    // Refetch events to reflect FM updates (auto end time, etc.)
    // (maybe, if triggered intensively, it can be debounced)
    api()?.refetchEvents();

    // Optional: Force full visual refresh (safe if refetch alone doesn't clear)
    api()?.render();
  };
  window.Calendar_SetView = (viewName) => api()?.changeView(mapViewName(viewName));
  window.Calendar_Next = () => {
    //console.log("[window.Calendar_Next]:");
    api()?.next();
  };
  window.Calendar_Prev = () => api()?.prev();
  window.Calendar_Today = () => api()?.today();
  window.Calendar_GotoDate = (dateStr) => {
    if (dateStr) api()?.gotoDate(dateStr);
  };

  window.fmwGetState = () => ({
    addonUUID,
    config,
    sessionState: {}, // initialSession, //getSessionItem(SESSION_STATE_KEY),
  });
};

// ── Core communication functions ────────────────────────────────────────────
// eg. Fetch events from FileMake

const sendToFileMaker = async (
  scriptName,
  data = {},
  metaOverrides = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
) => {
  // Build the same payload structure your FM scripts already expect
  const param = {
    Data: data,
    Meta: {
      AddonUUID: addonUUID,
      Config: config,
      ...metaOverrides,
    },
  };

  const paramJson = JSON.stringify(param);

  try {
    // fm-gofer will:
    // - generate promiseID + callbackName="FMGoferCallback"
    // - wrap your paramJson into { promiseID, callbackName, parameter: paramJson }
    // - call FileMaker.PerformScript(scriptName, thatWrappedJSON)
    const rawResult = await FMGofer.PerformScript(
      scriptName,
      paramJson, // your original JSON payload
      timeoutMs, // e.g. 30000
      `sendToFileMaker: Timeout waiting for ${scriptName}`,
    );

    // rawResult is whatever string the FM script passed in the 2nd param of Perform JavaScript
    // (your current scripts pass a JSON string → we can parse it)
    let response;
    try {
      response = JSON.parse(rawResult);
    } catch (parseErr) {
      console.warn(`[sendToFileMaker] Result from ${scriptName} not valid JSON:`, rawResult);
      response = { response: { data: [], dataInfo: {} }, messages: [] };
    }

    const messages = Array.isArray(response?.messages) ? response.messages : [];

    // Let FM return any code/message — we handle 401 here as success/empty
    const has401 = messages.some(
      (msg) => msg?.code === "401" || msg?.code === 401 || msg?.code === 401,
    );
    if (has401) {
      console.log(`[sendToFileMaker → ${scriptName}] 401 detected – treating as empty results`);
      return { dataInfo: {}, data: [] };
    }

    // Check for real errors (non-0, non-401)
    const errorMsg = messages.find((msg) => {
      const code = msg?.code;
      return code !== "0" && code !== 0 && code !== "401" && code !== 401;
    });

    if (errorMsg) {
      throw new Error(
        `[sendToFileMaker -> ${scriptName}]: Error calling FM and/or its results: ${JSON.stringify(errorMsg)}`,
      );
    }

    // Success path
    return {
      dataInfo: response?.response?.dataInfo || {},
      data: response?.response?.data || [],
    };
  } catch (err) {
    // Catches:
    // - timeout rejection from fm-gofer
    // - explicit reject from FM (3rd param = True)
    // - parse errors or thrown errors above
    console.error(`[sendToFileMaker → ${scriptName}]: Exception FM <-> Callback: `, err);
    return { dataInfo: {}, data: [] }; // Graceful fallback like before
  }
};

// fetchRecords stays almost the same — just remove the old 401 handling since it's now in sendToFileMaker
const fetchRecords = async (findRequest) => {
  try {
    return await sendToFileMaker("FCCalendarFind", findRequest);
  } catch (err) {
    console.error("[fetchRecords] Unexpected outer error:", err);
    return { dataInfo: {}, data: [] };
  }
};

// let isFetchingEventsInRange = false;

const fetchEventsInRange = async (startStr, endStr) => {
  // if (isFetchingEventsInRange) {
  //   console.log("[fetchEventsInRange] Already fetching -> skipping duplicate call");
  //   return [];
  // }
  // isFetchingEventsInRange = true;

  const startDate = new Date(startStr);
  const endDate = new Date(endStr);

  //window.alert("filemakerInterface.fetchEventsInRange()");

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

    // Depending on what fetchRecords returns, unwrap appropriately
    const records = result?.response?.data || result?.data || [];

    if (!Array.isArray(records)) {
      console.warn("No valid data array in response", result);
      return [];
    }

    console.log(`[fetchEventsInRange] (${records.length}) Events from FM received`);

    return records;
  } catch (err) {
    console.error("[fetchEventsInRange] fetchRecords failed:", err);
    return [];
  } finally {
    // isFetchingEventsInRange = false;
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

// ── Event notify ────────────────────────────────────────────────────────────

// Fire-and-forget version using fm-gofer
// Yet, as now we expect a callback from Filemaker (not fire-and-forget anymore), we display the error.
const _sendWrappedEvent = (eventType, dataPayload = {}) => {
  const fullParam = {
    Data: dataPayload,
    Meta: {
      EventType: eventType,
      AddonUUID: addonUUID || window.__initialProps__?.AddonUUID,
      Config: config,
      // Note: No Callback or FetchId needed — FM script doesn't use them
      //FetchId: fetchId,
      //Callback: "Fmw_Callback",
    },
  };

  const paramJson = JSON.stringify(fullParam);

  // Fire and forget: call but don't await, just log/catch errors
  FMGofer.PerformScript(
    "FCCalendarEvents",
    paramJson,
    9, // timeout in ms
    `[sendWrappedEvent] '${eventType}' Fired and forgetted`,
  )
    .then(() => {
      // Do nothing, fired and forgetted.
      //console.debug(`[sendWrappedEvent] '${eventType}' FM event sent`);
    })
    .catch((err) => {
      // NOTE: DOESN'T MATTER!
      // Silent fail — typical for fire-and-forget (FM did its job or timed out harmlessly)
      // Could log if debugging: console.warn(`[sendWrappedEvent ${eventType}] ignored:`, err.message);
      //console.log(`[sendWrappedEvent] ${eventType}: Error or Timeout (all good): `, err);
      // contains 'fired and forgetted' or another error
      console.log(err);
    });
};

// Debounce sendWrappedEvent
const sendWrappedEvent = debounce(_sendWrappedEvent, DEFAULT_DEBOUNCE_TIME_MS, {
  leading: true, // fire immediately -> more responsive
  trailing: true, // fire the last one
});

// Event Click (already working, but consistent with wrapper)
const notifyEventClick = (event) => {
  console.log("[notifyEventClick] Event clicked:", event.id);

  //window.alert("filemakerInterface.notifyEventClick()");

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

  //window.alert("filemakerInterface.notifyViewChange()");

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

  //window.alert("filemakerInterface.notifyDateSelect()");

  // Use local Date objects
  let adjustedStart = new Date(info.start);
  let adjustedEnd = new Date(info.end);

  // --
  // Snapping to previous last event
  // --

  const calendarApi = calendarRef?.current?.getApi();
  if (calendarApi) {
    const allEvents = calendarApi.getEvents();

    // Filter same-day, non-all-day events that end within the clicked slot (overlap or middle end)
    const endingInSlotEvents = allEvents.filter((event) => {
      const sameDay = new Date(event.start).toDateString() === adjustedStart.toDateString();
      const endsInSlot = event.end > adjustedStart && event.end < adjustedEnd; // Ends after slot start and before slot end
      const isAllDay = event.allDay;

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
  // -- End of snapping

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

  sendWrappedEvent("NewEventFromSelected", dataPayload);

  // NOTE: Refetch events -> call FM:FCCalendarFind
  // To remove residual effect of default visit created
  // Let FM do it
  // window.Calendar_Refresh?.();
};

const notifyEventDrop = (info, calendarRef) => {
  //window.alert("filemakerInterface.notifyEventDrops()");

  if (!info?.event?.id) {
    console.error("[notifyEventDrop] No event ID");
    return;
  }

  console.log("[notifyEventDrop] Event dropped:", info.event.id);

  // Use local Date objects
  let adjustedStart = info.event.start;
  let adjustedEnd = info.event.end;

  // --
  // Snapping to previous last event
  // --

  const adjustedDuration = adjustedEnd - adjustedStart;

  const calendarApi = calendarRef?.current?.getApi();
  if (calendarApi) {
    const allEvents = calendarApi.getEvents();

    // Filter same-day, non-all-day events that end within the clicked slot (overlap or middle end)
    const endingInSlotEvents = allEvents.filter((event) => {
      const sameDay = new Date(event.start).toDateString() === adjustedStart.toDateString();
      const endsInSlot = event.end > adjustedStart && event.end < adjustedEnd; // Ends after slot start and before slot end
      const isAllDay = event.allDay;

      return sameDay && !isAllDay && endsInSlot;
    });

    if (endingInSlotEvents.length > 0) {
      // Snap to the latest-ending event in the slot
      const previousEvent = endingInSlotEvents.sort((a, b) => b.end - a.end)[0];

      console.log(
        "[notifyEventDrop] Ending in slot found, snapping start to:",
        previousEvent.end.toLocaleString(),
      );

      adjustedStart = new Date(previousEvent.end.getTime());
    } else {
      console.log("[notifyEventDrop] No event ending in slot - using slot start");
    }
  }

  if (adjustedDuration > 0) {
    adjustedEnd = new Date(adjustedStart.getTime() + adjustedDuration);
  } else {
    // fallback to 60-minute duration
    adjustedEnd = new Date(adjustedStart.getTime() + 60 * 60 * 1000);
  }
  // -- end of snapping calculation

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

  // NOTE: EventDropped does not open any window, good to refresh now.
  // Let FM do it.
  // window.Calendar_Refresh?.();
};

// Event Resize (uses "EventResized", send new end date/time and field names)
const notifyEventResize = (info) => {
  //window.alert("filemakerInterface.notifyEventResize()");

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

  // NOTE: EventResized does not open any window, good to refresh now.
  // Let FM do it
  // window.Calendar_Refresh?.();
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
  sendWrappedEvent,
};

// ---------------------------------------------------------------------------------------
