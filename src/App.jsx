// src/App.jsx

// populated by FM
if (window.__initialProps__ === undefined || window.__initialProps__ === "__PROPS__") {
  window.__initialProps__ = "__PROPS__"; // Ensure placeholder survives
}

/*
 * Handle __PROPS__ updated by FM
 */
(function initializeFMProps() {
  const propsValue = window.__initialProps__;

  if (propsValue === "__PROPS__" || propsValue === undefined || propsValue === null) {
    console.warn("[initializeFMProps] Placeholder not substituted → empty config");
    window.__initialProps__ = {};

    window.alert("init FM Props warning placeholder not substituted");
    return;
  }

  // If it's ALREADY an object → we're good! (this is your current case)
  if (typeof propsValue === "object" && propsValue !== null) {
    console.log("[initializeFMProps] __initialProps__ already set.");
    //window.alert("init FM Props already set");
    return; // No need to parse
  }

  // Fallback: If it's a string, try to parse it (with cleanup)
  if (typeof propsValue === "string") {
    let cleaned = propsValue
      .replace(/^["']+|["']+$/g, "") // remove outer quotes
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .trim();

    try {
      window.__initialProps__ = JSON.parse(cleaned);
      console.log("[initializeFMProps] success, initial props set.");

      //window.alert("init FM Props sucesss");
    } catch (err) {
      console.error("[initializeFMProps] String parse failed:", err.message);
      console.error("[initializeFMProps] Cleaned string was:", cleaned);
      console.error("[initializeFMProps] Config:", window.__initialProps__.Config || {});
      window.__initialProps__ = {};

      window.alert("init FM Props parse failed - set to empty");
    }

    return;
  }

  //window.alert("init FM Props ultimate fallback");

  // Ultimate fallback
  console.warn("[initializeFMProps] Unexpected type → forcing empty window.__initialProps__");
  window.__initialProps__ = {};
})();

// Register the callback when the configuration has been change so we can fully reload the web page.
window.fmwConfigChangeCallback = (result = null, fetchId = null) => {
  console.log("[fmwConfigChangeCallback] Config saved - reloading page");
  // Force full reload of the current page (re-injects __initialProps__ with new config)
  window.location.reload(true); // true = force reload from server, no cache
};

/*
 * Now start the React App
 */

import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import multiMonthPlugin from "@fullcalendar/multimonth";

import tippy from "tippy.js";
import "tippy.js/dist/tippy.css";

import ConfigPanel from "./ConfigPanel";

import {
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
} from "./filemakerInterface";

// src/App.jsx
// (Keep the top initialization script and imports unchanged)

/*
 * The App()
 */
function App() {
  const calendarRef = useRef(null);
  const currentEvents = useRef([]); // Ref for fallback events (replaces state)
  const [isInitialized, setIsInitialized] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [addonUUID, setAddonUUID] = useState(null); // State for addonUUID
  const [isCalendarReady, setIsCalendarReady] = useState(false);

  // ── 1. Initialize FileMaker interface once on mount ───────────────────────
  useEffect(() => {
    if (isInitialized) return;
    console.log("[useEffect] Init...");

    //window.alert("App.useEffect: init...");

    // Silence FileMaker's legacy auto-call attempts
    window.Calendar_Refresh = () => {};
    window.Calendar_SetView = () => {}; // already exists but harmless to redefine
    window.Calendar_Next = () => {};
    window.Calendar_Prev = () => {};
    window.Calendar_Today = () => {};
    window.fmwInit = () => {}; // sometimes called too

    // Force re-parse if it's still the placeholder
    if (typeof window.__initialProps__ === "string" && window.__initialProps__ === "__PROPS__") {
      console.warn("[App.useEffect] Placeholder not substituted - config will be empty");
    }

    fmwInit(() => {
      //window.alert("App.fmwInit(): start");

      // Once FileMaker is ready and props are loaded
      setupWindowFunctions(calendarRef);

      //window.alert("App.fmwInit(): setupWindowFunctions done");

      setAddonUUID(window.__initialProps__?.AddonUUID);

      // Initialise Locale
      if (window.__initialProps__?.Locale && window.__initialProps__.Locale.value) {
        // Locale is passed alongside Meta, AddonUUID, .. put it into Config
        window.__initialProps__.Config.Locale = window.__initialProps__.Locale;
      } else {
        console.warn("[fmwInit]: Locale has NOT been set dynamically, default to 'en'.");
        window.__initialProps__.Config.Locale = { type: "text", value: "en" };
      }

      // Check ShowConfig AFTER init (safe)
      const configMode = window.__initialProps__?.ShowConfig === true;
      setShowConfig(configMode);

      //window.alert("App.fmwInit(): locale intialised");

      // Initialize global tooltips (common in calendar add-ons)
      tippy("[data-tippy-content]", {
        placement: "top",
        allowHTML: true,
        maxWidth: 300,
      });

      const locale = getConfigField("Locale", "en");
      console.log("[App.fmwInit] Init done, locale: ", locale);

      //window.alert("App.fmwInit(): initialised");

      setIsInitialized(true);
    });

    if (calendarRef.current) {
      setIsCalendarReady(true); // will call again 'dayHeaderFormat'
    }
  }, [isInitialized]);

  // ── 2. Dynamic event source for FullCalendar ──────────────────────────────
  // 1. Define the raw async fetch (useCallback to memoize, no deps needed now)
  const rawFetch = useCallback(
    async (fetchInfo, successCallback, failureCallback) => {
      try {
        /*console.log(
          "[Fetch] Starting for range:",
          fetchInfo.startStr,
          "-",
          fetchInfo.endStr,
        );*/

        const eventsData = await fetchEventsInRange(fetchInfo.startStr, fetchInfo.endStr);

        //console.log("[Raw Fetch (records from FM)]", eventsData); // ← NEW: see the actual array

        const fcEvents = eventsData
          .map((record, index) => {
            const event = mapRecordToEvent(record);
            if (!event) {
              console.warn(`[Mapping failed for record ${index}]`, record);
            }
            return event;
          })
          .filter((event) => event !== null && event.id);

        currentEvents.current = fcEvents; // Update ref for future fallbacks
        successCallback(fcEvents);

        console.log("[rawFetch of events] Completed - Mapped count:", fcEvents.length, fcEvents);
      } catch (error) {
        console.error("[rawFetch of events] Failed:", error);
        successCallback(currentEvents.current); // Use ref fallback
      }
    },
    [], // No dependencies → stable across renders
  );

  //window.alert("App - rawFetch defined.");

  // 2. Create a debounced version (memoized so it doesn't recreate on render)
  const debouncedFetch = useMemo(() => {
    let timeoutId;
    return (fetchInfo, success, failure) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => rawFetch(fetchInfo, success, failure), 500);
    };
  }, [rawFetch]);

  //window.alert("App - debouncedFetch defined.");

  // ── 3. Render ─────────────────────────────────────────────────────────────
  if (!isInitialized) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          color: "#666",
        }}
      >
        Loading...
      </div>
    );
  }

  // ── 4. Show Config? ─────────────────────────────────────────────────────────────
  // Conditional rendering: Config mode vs Calendar mode
  if (showConfig) {
    // Config-only mode (same bundle, but only panel)
    return (
      <div style={{ height: "100vh", width: "100vw", background: "#f8f9fa" }}>
        <ConfigPanel
          addonUUID={addonUUID}
          onClose={() => {
            // Optional: tell FM to close the card window or reset ShowConfig
            //window.FileMaker?.PerformScript("SomeCloseScript", "");
            console.log("[DEBUG] App().ShowConfig: onClose config. ");
          }}
          onSave={() => {
            // Optional: refresh main calendar if needed
            //window.FileMaker?.PerformScript("FCCalendarRefresh", "");
            console.log("[DEBUG] App().ShowConfig: onSave config. ");
          }}
        />
      </div>
    );
  }

  //window.alert("App - return of fullCalendar.");

  return (
    <div style={{ height: "98vh", width: "99vw" }}>
      <FullCalendar
        ref={calendarRef}
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, listPlugin, multiMonthPlugin]}
        initialView={mapViewName(getConfigField("StartingView", "Month"))}
        firstDay={getFirstDayOfWeek()}
        headerToolbar={
          false /*{
          left: "", //"prev,next today",
          center: "title",
          right: "", //"dayGridMonth,timeGridWeek,timeGridDay,listWeek",
          }*/
        }
        // TEST: SHOULD BE en
        locale={getConfigField("Locale", "en")} // e.g. "en" or "fr"
        timeZone={getConfigField("TimeZone", "local")}
        /*
        dayHeaderFormat={(dateObj) => {
          const locale = getConfigField("Locale", "en");

          // Try to get real date safely
          let realDate;
          try {
            realDate = dateObj.marker || dateObj.date || new Date();
          } catch {
            realDate = new Date();
          }

          // If not Date, fallback
          if (!(realDate instanceof Date) || isNaN(realDate.getTime())) {
            realDate = new Date();
          }

          const weekday = realDate.toLocaleDateString(locale, {
            weekday: "short",
          });
          const day = realDate.toLocaleDateString(locale, { day: "numeric" });
          const month = realDate.toLocaleDateString(locale, {
            month: "numeric",
          });

          // Force Day / Month order
          return `${weekday} ${day} / ${month}`;
        }}
        */
        dayHeaderFormat={{
          weekday: "short", // "Monday" or "Lundi" (full name) (or: 'long')
          day: "2-digit", // "14"
          month: "2-digit", // "Jan" or "janv." (ex: 'short')
          separator: " / ", // Custom separator
        }}
        allDaySlot={false}
        editable={true}
        eventDurationEditable={true}
        eventResizableFromStart={true}
        eventDragMinDistance={1}
        dragScroll={true}
        selectable={true}
        selectMirror={true}
        dayMaxEvents={true}
        events={debouncedFetch}
        eventClick={(info) => notifyEventClick(info.event)}
        eventDrop={(info) => notifyEventDrop(info)}
        eventResize={(info) => notifyEventResize(info)}
        select={(info) => notifyDateSelect(info, calendarRef)}
        datesSet={(info) => notifyViewChange(info.view)}
        // Optional but recommended enhancements:
        height="100%"
        slotMinTime={getConfigField("DayStartTime", "08:00:00")}
        slotMaxTime={getConfigField("DayEndTime", "20:00:00")}
        slotDuration="00:30:00" // Each slot = 15 minutes (default: "00:30:00")
        slotLabelInterval="01:00:00" // Show time labels every 1 hour (default: "00:30:00")
        slotLabelFormat={{
          hour: "2-digit", // 08, 09, 20, etc.
          minute: "2-digit", // 00, 30, etc.
          hour12: false, // 24-hour format (no am/pm)
        }}
        snapDuration="00:30:00" // Snap selections to 15-minute increments // The time interval at which a dragged event will snap to the time axis.
        // ... rest of your props
        // You can add more later: eventContent, custom eventDidMount for tooltips, etc.
        eventMinHeight={13} // Slightly higher than 18 → better readability
        slotEventOverlap={false} // ← Disable visual overlap (clean stacking)
      />
    </div>
  );
}

//{/* Initial header (optional) */}
/*<div style={{ color: "#888", fontWeight: "bold", marginBottom: "0.4rem" }}>Debug Logs</div>*/
export default App;
