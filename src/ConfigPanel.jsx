// src/ConfigPanel.jsx

import React, { useState, useEffect } from "react";
import "./ConfigPanel.css";

const ConfigPanel = ({ onClose, onSave }) => {
  const [activeTab, setActiveTab] = useState("general");
  const [config, setConfig] = useState({});

  useEffect(() => {
    // Load current config from window.__initialProps__.Config
    const initial = window.__initialProps__?.Config || {};
    setConfig({
      StartingView: initial.StartingView?.value || "Month",
      StartOnDay: initial.StartOnDay?.value || "Sunday",
      DefaultEventStyle: initial.DefaultEventStyle?.value || "",
      EventPrimaryKeyField: initial.EventPrimaryKeyField?.value || "",
      EventTitleField: initial.EventTitleField?.value || "",
      EventStartDateField: initial.EventStartDateField?.value || "",
      EventStartTimeField: initial.EventStartTimeField?.value || "",
      EventEndDateField: initial.EventEndDateField?.value || "",
      EventEndTimeField: initial.EventEndTimeField?.value || "",
      EventAllDayField: initial.EventAllDayField?.value || "",
      EventEditableField: initial.EventEditableField?.value || "",
      EventDetailLayout: initial.EventDetailLayout?.value || "",
      Locale: initial.Locale?.value || "en",
      TimeZone: initial.TimeZone?.value || "local",
      DayStartTime: initial.DayStartTime?.value || "08:00:00",
      DayEndTime: initial.DayEndTime?.value || "20:00:00",
      EventFilterField: initial.EventFilterField?.value || "",
      EventFilterQueryField: initial.EventFilterQueryField?.value || "",
    });
  }, []);

  const handleChange = (key, value) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    const updated = {};
    Object.entries(config).forEach(([key, value]) => {
      updated[key] = { type: getFieldType(key), value };
    });

    let paramJson = JSON.stringify(updated);

    // Step 1: Trim
    paramJson = paramJson.trim();

    // Step 2: Force unquote by checking if it's a quoted string
    if (paramJson.startsWith('"') && paramJson.endsWith('"')) {
      console.log("[ConfigPanel] Detected quoted string - forcing unquote");
      paramJson = paramJson.slice(1, -1); // Remove outer quotes
      paramJson = paramJson.replace(/\\"/g, '"'); // Unescape inner
    }

    // Step 3: If it STILL looks quoted (multiple layers), repeat once more
    if (paramJson.startsWith('"') && paramJson.endsWith('"')) {
      console.warn("[ConfigPanel] Double quoted - second force unquote");
      paramJson = paramJson.slice(1, -1).replace(/\\"/g, '"');
    }

    // Step 4: Final safety unescape
    paramJson = paramJson.replace(/\\"/g, '"').replace(/\\\\/g, "\\");

    console.log(
      "[ConfigPanel] FINAL JSON sent:",
      paramJson.substring(0, 200) + "...",
    );

    window.FileMaker?.PerformScript("FCCalendarSaveConfig", paramJson);

    onSave?.();
  };

  // Helper to get field type (based on original bundle)
  const getFieldType = (key) => {
    const selectFields = [
      "StartingView",
      "StartOnDay",
      "DefaultEventStyle",
      "EventAllDayField",
      "EventEditableField",
    ];
    return selectFields.includes(key) ? "select" : "text";
  };

  return (
    <div className="config-panel">
      <div className="config-content">
        <div className="config-header">
          <h2>Calendar Configuration</h2>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="config-tabs">
          <button
            className={`tab-btn ${activeTab === "general" ? "active" : ""}`}
            onClick={() => setActiveTab("general")}
          >
            General
          </button>
          <button
            className={`tab-btn ${activeTab === "fields" ? "active" : ""}`}
            onClick={() => setActiveTab("fields")}
          >
            Fields
          </button>
          <button
            className={`tab-btn ${activeTab === "appearance" ? "active" : ""}`}
            onClick={() => setActiveTab("appearance")}
          >
            Appearance
          </button>
          <button
            className={`tab-btn ${activeTab === "advanced" ? "active" : ""}`}
            onClick={() => setActiveTab("advanced")}
          >
            Advanced
          </button>
        </div>

        <div className="config-form">
          {/* General Tab */}
          {activeTab === "general" && (
            <div className="tab-content">
              <div className="form-group">
                <label>Starting View</label>
                <select
                  value={config.StartingView}
                  onChange={(e) => handleChange("StartingView", e.target.value)}
                >
                  <option value="Month">Month</option>
                  <option value="Week">Week</option>
                  <option value="Day">Day</option>
                  <option value="List">List</option>
                </select>
              </div>
              <div className="form-group">
                <label>Start Week On</label>
                <select
                  value={config.StartOnDay}
                  onChange={(e) => handleChange("StartOnDay", e.target.value)}
                >
                  <option value="Sunday">Sunday</option>
                  <option value="Monday">Monday</option>
                </select>
              </div>
              <div className="form-group">
                <label>Default Event Style</label>
                <select
                  value={config.DefaultEventStyle}
                  onChange={(e) =>
                    handleChange("DefaultEventStyle", e.target.value)
                  }
                >
                  <option value="">None</option>
                  <option value="Blue">Blue</option>
                  <option value="Green">Green</option>
                  <option value="Purple">Purple</option>
                  <option value="Red">Red</option>
                  <option value="Yellow">Yellow</option>
                  <option value="Dark Blue">Dark Blue</option>
                  <option value="Dark Green">Dark Green</option>
                  <option value="Dark Purple">Dark Purple</option>
                </select>
              </div>
            </div>
          )}

          {/* Fields Tab */}
          {activeTab === "fields" && (
            <div className="tab-content">
              <div className="form-group">
                <label>Event Primary Key Field</label>
                <input
                  type="text"
                  value={config.EventPrimaryKeyField}
                  onChange={(e) =>
                    handleChange("EventPrimaryKeyField", e.target.value)
                  }
                />
              </div>
              <div className="form-group">
                <label>Event Title Field</label>
                <input
                  type="text"
                  value={config.EventTitleField}
                  onChange={(e) =>
                    handleChange("EventTitleField", e.target.value)
                  }
                />
              </div>
              <div className="form-group">
                <label>Start Date Field</label>
                <input
                  type="text"
                  value={config.EventStartDateField}
                  onChange={(e) =>
                    handleChange("EventStartDateField", e.target.value)
                  }
                />
              </div>
              <div className="form-group">
                <label>Start Time Field</label>
                <input
                  type="text"
                  value={config.EventStartTimeField}
                  onChange={(e) =>
                    handleChange("EventStartTimeField", e.target.value)
                  }
                />
              </div>
              <div className="form-group">
                <label>End Date Field</label>
                <input
                  type="text"
                  value={config.EventEndDateField}
                  onChange={(e) =>
                    handleChange("EventEndDateField", e.target.value)
                  }
                />
              </div>
              <div className="form-group">
                <label>End Time Field</label>
                <input
                  type="text"
                  value={config.EventEndTimeField}
                  onChange={(e) =>
                    handleChange("EventEndTimeField", e.target.value)
                  }
                />
              </div>
              <div className="form-group">
                <label>All Day Field</label>
                <input
                  type="text"
                  value={config.EventAllDayField}
                  onChange={(e) =>
                    handleChange("EventAllDayField", e.target.value)
                  }
                />
              </div>
              <div className="form-group">
                <label>Editable Field</label>
                <input
                  type="text"
                  value={config.EventEditableField}
                  onChange={(e) =>
                    handleChange("EventEditableField", e.target.value)
                  }
                />
              </div>
              <div className="form-group">
                <label>Event Detail Layout</label>
                <input
                  type="text"
                  value={config.EventDetailLayout}
                  onChange={(e) =>
                    handleChange("EventDetailLayout", e.target.value)
                  }
                />
              </div>
            </div>
          )}

          {/* Appearance Tab */}
          {activeTab === "appearance" && (
            <div className="tab-content">
              <div className="form-group">
                <label>Locale</label>
                <input
                  type="text"
                  value={config.Locale}
                  onChange={(e) => handleChange("Locale", e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Time Zone</label>
                <input
                  type="text"
                  value={config.TimeZone}
                  onChange={(e) => handleChange("TimeZone", e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Day Start Time</label>
                <input
                  type="time"
                  value={config.DayStartTime}
                  onChange={(e) => handleChange("DayStartTime", e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Day End Time</label>
                <input
                  type="time"
                  value={config.DayEndTime}
                  onChange={(e) => handleChange("DayEndTime", e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Advanced Tab */}
          {activeTab === "advanced" && (
            <div className="tab-content">
              <div className="form-group">
                <label>Event Filter Field</label>
                <input
                  type="text"
                  value={config.EventFilterField}
                  onChange={(e) =>
                    handleChange("EventFilterField", e.target.value)
                  }
                />
              </div>
              <div className="form-group">
                <label>Event Filter Query Field</label>
                <input
                  type="text"
                  value={config.EventFilterQueryField}
                  onChange={(e) =>
                    handleChange("EventFilterQueryField", e.target.value)
                  }
                />
              </div>
            </div>
          )}
        </div>

        <div className="config-footer">
          <button className="btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-save" onClick={handleSave}>
            Save Configuration
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfigPanel;
