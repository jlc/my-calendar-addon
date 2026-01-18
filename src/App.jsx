// src/App.jsx

// populated by FM
if (
  window.__initialProps__ === undefined ||
  window.__initialProps__ === "__PROPS__"
) {
  window.__initialProps__ = "__PROPS__"; // Ensure placeholder survives
}

/*
 * Handle __PROPS__ updated by FM
 */
(function initializeFMProps() {
  const propsValue = window.__initialProps__;

  if (
    propsValue === "__PROPS__" ||
    propsValue === undefined ||
    propsValue === null
  ) {
    console.warn("[FM Init] Placeholder not substituted → empty config");
    window.__initialProps__ = {};
    return;
  }

  // If it's ALREADY an object → we're good! (this is your current case)
  if (typeof propsValue === "object" && propsValue !== null) {
    /*console.log(
      "[FM Init] SUCCESS: __initialProps__ is already a parsed object",
    );*/
    if (propsValue.Config) {
      console.log("Config keys:", Object.keys(propsValue.Config));
    }
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
      console.log("[FM Init] Parsed string to object successfully");
      console.log(
        "Config keys:",
        Object.keys(window.__initialProps__.Config || {}),
      );
    } catch (err) {
      console.error("[FM Init] String parse failed:", err.message);
      console.error("Cleaned string was:", cleaned);
      window.__initialProps__ = {};
    }
    return;
  }

  // Ultimate fallback
  console.warn("[FM Init] Unexpected type → forcing empty");
  window.__initialProps__ = {};
})();

/*
 * Now start the React App
 */

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";

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

  // ── 1. Initialize FileMaker interface once on mount ───────────────────────
  useEffect(() => {
    if (isInitialized) return;

    // Silence FileMaker's legacy auto-call attempts
    window.Calendar_Refresh = () => {};
    window.Calendar_SetView = () => {}; // already exists but harmless to redefine
    window.Calendar_Next = () => {};
    window.Calendar_Prev = () => {};
    window.Calendar_Today = () => {};
    window.fmwInit = () => {}; // sometimes called too

    // Force re-parse if it's still the placeholder
    if (
      typeof window.__initialProps__ === "string" &&
      window.__initialProps__ === "__PROPS__"
    ) {
      console.warn("[FM] Placeholder not substituted - config will be empty");
    }

    fmwInit(() => {
      // Once FileMaker is ready and props are loaded
      setupWindowFunctions(calendarRef);

      // Check ShowConfig AFTER init (safe)
      const configMode = window.__initialProps__?.ShowConfig === true;
      setShowConfig(configMode);

      // Initialize global tooltips (common in calendar add-ons)
      tippy("[data-tippy-content]", {
        placement: "top",
        allowHTML: true,
        maxWidth: 300,
      });

      setIsInitialized(true);
    });
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

        const eventsData = await fetchEventsInRange(
          fetchInfo.startStr,
          fetchInfo.endStr,
        );

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

        console.log(
          "[rawFetch of events] Completed - Mapped count:",
          fcEvents.length,
          fcEvents,
        );
      } catch (error) {
        console.error("[rawFetch of events] Failed:", error);
        successCallback(currentEvents.current); // Use ref fallback
      }
    },
    [], // No dependencies → stable across renders
  );

  // 2. Create a debounced version (memoized so it doesn't recreate on render)
  const debouncedFetch = useMemo(() => {
    let timeoutId;
    return (fetchInfo, success, failure) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => rawFetch(fetchInfo, success, failure), 500);
    };
  }, [rawFetch]);

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

  return (
    <div style={{ height: "98vh", width: "99vw" }}>
      <FullCalendar
        ref={calendarRef}
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, listPlugin]}
        initialView={mapViewName(getConfigField("StartingView", "Month"))}
        firstDay={getFirstDayOfWeek()}
        headerToolbar={
          false /*{
          left: "", //"prev,next today",
          center: "title",
          right: "", //"dayGridMonth,timeGridWeek,timeGridDay,listWeek",
          }*/
        }
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
        select={(info) => notifyDateSelect(info)}
        datesSet={(info) => notifyViewChange(info.view)}
        // Optional but recommended enhancements:
        height="100%"
        locale={getConfigField("Locale", "en")}
        timeZone={getConfigField("TimeZone", "local")}
        slotMinTime={getConfigField("DayStartTime", "08:00:00")}
        slotMaxTime={getConfigField("DayEndTime", "20:00:00")}
        // You can add more later: eventContent, custom eventDidMount for tooltips, etc.
        // Optional: force visual debug
        eventMinHeight={30} // Ensures events are tall enough for handles
      />
    </div>
  );
}

export default App;
