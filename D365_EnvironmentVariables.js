/**
 * D365_EnvironmentVariables.js
 * Dynamics 365 - Utility for retrieving Environment Variable values
 * with automatic fallback to the configured default value.
 *
 * Usage:
 *   const value = await EnvironmentVariables.getValue("kofc_variableName");
 *   const num   = await EnvironmentVariables.getValueAs("kofc_variableName", "number");
 */

"use strict";

var EnvironmentVariables = EnvironmentVariables || (function () {

    /**
     * Fetches the current value (environmentvariablevalue) for a given schema name.
     * If no current value row exists, falls back to the definition's defaultvalue.
     *
     * @param {string} schemaName  - The schema name of the environment variable
     *                               (e.g. "kofc_MyApiEndpoint").
     * @returns {Promise<string|null>} Resolved string value, or null if not found.
     */
    async function getValue(schemaName) {
        if (!schemaName) {
            console.error("[EnvVar] schemaName is required.");
            return null;
        }

        try {
            // ── Step 1: Resolve the definition (gets the defaultvalue) ────────────
            const defQuery =
                "?$select=environmentvariabledefinitionid,defaultvalue,displayname" +
                "&$filter=schemaname eq '" + _escape(schemaName) + "'";

            const defResult = await Xrm.WebApi.retrieveMultipleRecords(
                "environmentvariabledefinition",
                defQuery
            );

            if (!defResult || defResult.entities.length === 0) {
                console.warn("[EnvVar] Definition not found for: " + schemaName);
                return null;
            }

            const definition     = defResult.entities[0];
            const definitionId   = definition["environmentvariabledefinitionid"];
            const defaultValue   = definition["defaultvalue"] || null;

            // ── Step 2: Check for an override (current) value ─────────────────────
            const valQuery =
                "?$select=value" +
                "&$filter=_environmentvariabledefinitionid_value eq " + definitionId +
                "&$top=1";

            const valResult = await Xrm.WebApi.retrieveMultipleRecords(
                "environmentvariablevalue",
                valQuery
            );

            if (valResult && valResult.entities.length > 0) {
                const currentValue = valResult.entities[0]["value"];
                if (currentValue !== undefined && currentValue !== null && currentValue !== "") {
                    console.log("[EnvVar] Current value found for: " + schemaName);
                    return currentValue;
                }
            }

            // ── Step 3: Fall back to default value ────────────────────────────────
            if (defaultValue !== null) {
                console.log("[EnvVar] Using default value for: " + schemaName);
                return defaultValue;
            }

            console.warn("[EnvVar] No current or default value for: " + schemaName);
            return null;

        } catch (error) {
            _handleError("[EnvVar] Error retrieving '" + schemaName + "'", error);
            return null;
        }
    }

    /**
     * Retrieves an environment variable value and coerces it to a target type.
     *
     * @param {string} schemaName  - Schema name of the environment variable.
     * @param {"string"|"number"|"boolean"|"json"} type - Target type.
     * @param {*} [fallback]       - Value returned when the variable is null/undefined.
     * @returns {Promise<*>} The coerced value, or the fallback.
     */
    async function getValueAs(schemaName, type, fallback) {
        const raw = await getValue(schemaName);

        if (raw === null || raw === undefined) {
            return (fallback !== undefined) ? fallback : null;
        }

        try {
            switch ((type || "string").toLowerCase()) {
                case "number":
                    return Number(raw);
                case "boolean":
                    return raw.toLowerCase() === "true" || raw === "1";
                case "json":
                    return JSON.parse(raw);
                case "string":
                default:
                    return String(raw);
            }
        } catch (e) {
            console.error("[EnvVar] Type coercion failed for '" + schemaName + "' → " + type, e);
            return (fallback !== undefined) ? fallback : null;
        }
    }

    /**
     * Retrieves multiple environment variables in a single call.
     * Returns an object keyed by schema name.
     *
     * @param {string[]} schemaNames - Array of schema names.
     * @returns {Promise<Object.<string, string|null>>}
     */
    async function getMultiple(schemaNames) {
        if (!Array.isArray(schemaNames) || schemaNames.length === 0) {
            return {};
        }

        const results = await Promise.all(
            schemaNames.map(async function (name) {
                return { name: name, value: await getValue(name) };
            })
        );

        return results.reduce(function (acc, item) {
            acc[item.name] = item.value;
            return acc;
        }, {});
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    function _escape(str) {
        // Basic OData single-quote escape
        return str.replace(/'/g, "''");
    }

    function _handleError(message, error) {
        var detail = error && error.message ? error.message : JSON.stringify(error);
        console.error(message + " | " + detail);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        getValue    : getValue,
        getValueAs  : getValueAs,
        getMultiple : getMultiple
    };

})();


// ── Example usage (remove or guard behind a condition in production) ──────────
/*
(async function demo() {

    // 1. Raw string value with default fallback
    const endpoint = await EnvironmentVariables.getValue("kofc_ApiEndpoint");
    console.log("Endpoint:", endpoint);

    // 2. Typed retrieval — number with an inline fallback
    const timeout = await EnvironmentVariables.getValueAs("kofc_TimeoutMs", "number", 5000);
    console.log("Timeout:", timeout);

    // 3. Boolean flag
    const featureEnabled = await EnvironmentVariables.getValueAs("kofc_FeatureToggle", "boolean", false);
    console.log("Feature enabled:", featureEnabled);

    // 4. JSON payload stored in the variable
    const config = await EnvironmentVariables.getValueAs("kofc_JsonConfig", "json", {});
    console.log("Config:", config);

    // 5. Batch fetch
    const vars = await EnvironmentVariables.getMultiple([
        "kofc_ApiEndpoint",
        "kofc_MaxRetries",
        "kofc_FeatureToggle"
    ]);
    console.log("Batch:", vars);

})();
*/
