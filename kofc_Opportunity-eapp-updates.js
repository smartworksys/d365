/*
 * ============================================================================
 * kofc_Opportunity form web resource — EApp SSO updates
 * ============================================================================
 *
 * These are the ONLY changes needed in the kofc_Opportunity form script to use
 * the reusable auth client (kofc_authclient.js / namespace KOFC.Auth).
 *
 * HOW TO APPLY:
 *   1) ADD the three items below (EAPP_SSO_LIBRARY, EAPP_SSO_CONFIG,
 *      loadEappLibrary) once, anywhere at the top level of the form script.
 *   2) REPLACE your existing callEappFunctionAPP(...) function with the one below.
 *
 * Prerequisite web resources (uploaded + published):
 *   - kofc_authclient.js       (reusable KOFC.Auth library)
 *   - kofc_authcallback.html   (MSAL redirect page; registered in Entra as SPA redirect URI)
 *   - kofc_msalbrowsermin      (MSAL.js library)
 * ============================================================================
 */


/* ----------------------------------------------------------------------------
 * ADD #1 — Reusable auth client, loaded ON DEMAND (like MSAL), so any
 * form/entity can reuse it. No credentials are hard-coded in the library;
 * they are passed here via KOFC.Auth.configure(...).
 * -------------------------------------------------------------------------- */

// Registered web resource name of the reusable library. Adjust if yours differs.
var EAPP_SSO_LIBRARY = "/WebResources/kofc_authclient.js";

// Parameters passed to the library. Move these to environment variables if preferred.
var EAPP_SSO_CONFIG = {
    tenantId: "8a4b69f8-8bb7-4be5-9eda-6c40a157248c",
    clientId: "304822bd-97ab-42d7-b49f-b31ccdf976b8",
    apiAppId: "1379fc39-ee97-479f-95c0-c6c499dcecb0",
    scope: "access_as_user",
    boomiUrl: "https://dipaas.kofc.org/ws/rest/FunctionApps/GetEAApp",
    apiKey: "505da17a-aa80-4dff-96aa-130b9b3b2e1c",
    httpMethod: "POST",
    redirectWebResource: "kofc_authcallback.html",
    msalWebResourcePath: "/WebResources/kofc_msalbrowsermin",
    allowRedirect: true,
    debug: false
};


/* ----------------------------------------------------------------------------
 * ADD #2 — Dynamically inject the auth client (resolves immediately if already
 * loaded). Same pattern used to load MSAL.
 * -------------------------------------------------------------------------- */
function loadEappLibrary() {
    return new Promise(function (resolve, reject) {
        if (window.KOFC && window.KOFC.Auth) {
            resolve();
            return;
        }
        var script = document.createElement("script");
        script.src = Xrm.Utility.getGlobalContext().getClientUrl() + EAPP_SSO_LIBRARY;
        script.onload = function () {
            if (window.KOFC && window.KOFC.Auth) {
                resolve();
            } else {
                reject(new Error("Auth client loaded but KOFC.Auth is undefined."));
            }
        };
        script.onerror = function () {
            reject(new Error("Failed to load auth client: " + script.src));
        };
        document.head.appendChild(script);
    });
}


/* ----------------------------------------------------------------------------
 * REPLACE — your existing callEappFunctionAPP(...) with this version.
 * Called by navigateToEapp(...) after the member/contact check.
 * -------------------------------------------------------------------------- */
function callEappFunctionAPP(userID, OppID, eappURL, eappIntFunAppURL) {
    // Loads the reusable auth client, configures it, then launches EApp:
    // acquires the user's MSAL token (silent from cache; full-page redirect the first time),
    // calls Boomi with x-api-key, and opens eappURL + "?soreq=<base64>" in a new tab.
    //
    // First-time users: if a full-page sign-in redirect is required, openEapp resolves to
    // null and the redirect callback page (kofc_authcallback.html) finishes the flow
    // automatically on return — the user does NOT have to click the button again.
    Xrm.Utility.showProgressIndicator("Processing Request... Please Wait.");

    loadEappLibrary()
        .then(function () {
            KOFC.Auth.configure(EAPP_SSO_CONFIG);
            return KOFC.Auth.openEapp(userID, OppID, eappURL);
        })
        .then(function (ssoURL) {
            Xrm.Utility.closeProgressIndicator();
            // ssoURL === null => sign-in redirect in progress; callback page will finish it.
        })
        .catch(function (err) {
            Xrm.Utility.closeProgressIndicator();
            Xrm.Navigation.openAlertDialog({
                text: (err && err.message) ? err.message : String(err)
            });
        });
}
