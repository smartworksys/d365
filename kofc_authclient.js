/*
 * KOFC EApp SSO - reusable MSAL + Boomi integration library for Dynamics 365.
 *
 * REUSABLE / MODULAR USAGE (recommended):
 *   This library holds NO hard-coded credentials in production — callers pass config at
 *   runtime via KOFC.Auth.configure({...}). Load it on demand like MSAL (inject a <script>
 *   tag from your form script), then configure + call. Example (from a form web resource):
 *
 *     loadEappLibrary()                       // your helper: appends this file as a <script>
 *       .then(function () {
 *         KOFC.Auth.configure({
 *           tenantId, clientId, apiAppId, scope, boomiUrl, apiKey, httpMethod,
 *           redirectWebResource: "kofc_authcallback.html",
 *           msalWebResourcePath: "/WebResources/kofc_msalbrowsermin",
 *           allowRedirect: true, debug: false
 *         });
 *         return KOFC.Auth.openEapp(userId, oppId, eappUrl);
 *       });
 *
 * Public API:
 *   KOFC.Auth.configure(options)          set/override config (see CONFIGURABLE_KEYS)
 *   KOFC.Auth.openEapp(userId, oppId, url) token -> Boomi -> open url + "?soreq=<base64>"
 *   KOFC.Auth.callBoomiRaw(userId, oppId)  token -> Boomi -> returns raw response body
 *   KOFC.Auth.getAccessToken()             just the delegated user access token
 *   KOFC.Auth.callBoomi(primaryControl)    ribbon entry point (alerts on success/failure)
 *   KOFC.Auth.clearCache()                 wipe MSAL + EApp localStorage (re-test first-time)
 *   KOFC.Auth.getLogs/dumpLogs/clearLogs() diagnostics
 *
 * Legacy ribbon wire-up (still supported):
 *   Function name:  KOFC.Auth.callBoomi   Library: kofc_authclient.js   Parameter: PrimaryControl
 *
 * Prerequisites (uploaded as web resources):
 *   - kofc_msalbrowsermin        (MSAL library; see CONFIG.msalWebResourcePath)
 *   - kofc_authcallback.html     (MSAL redirect URI page; registered in Entra as an SPA redirect URI)
 *
 * NOTE: CONFIG below holds placeholder defaults only — real values should come from configure().
 *
 * SECURITY NOTE: x-api-key lives in client-side script and is visible to any form user.
 * Prefer having Boomi authorize on the user's bearer token instead of a shared key. If a key
 * is required, treat it as low-sensitivity and rotate it. Ideally move CONFIG values into a
 * Dataverse environment variable and read them via Xrm.WebApi rather than hard-coding here.
 *
 * MSAL CACHE (localStorage on this Dynamics origin):
 *   - Access token: typically ~1 hour (Entra default). After that MSAL refreshes silently.
 *   - Refresh token / account: can last much longer (tenant policy; often hours–~90 days).
 *   - Keys: anything starting with "msal." plus "kofc_eapp_msal_cfg".
 *
 * CLEAR CACHE (re-test as a first-time / no-token user):
 *   1) Preferred — browser console on the D365 form:
 *        KOFC.Auth.clearCache()
 *      then hard-refresh (Ctrl+Shift+R) and click the button again.
 *   2) Or DevTools → Application → Local Storage → https://<org>.crm.dynamics.com
 *      → delete keys starting with "msal." and "kofc_eapp_msal_cfg".
 *   3) Or open D365 in InPrivate/Incognito (no prior MSAL cache).
 *   Clearing site cookies for login.microsoftonline.com may also force a fresh SSO session.
 *
 * STRUCTURED LOGGING (troubleshooting):
 *   Set CONFIG.debug = true (default while diagnosing). Console filter: [KOFC.Auth]
 *   Console helpers:
 *     KOFC.Auth.getLogs()   — array of { ts, level, step, data }
 *     KOFC.Auth.dumpLogs()  — print JSON to console
 *     KOFC.Auth.clearLogs() — empty the in-memory ring buffer
 *   Tokens / apiKey / Authorization are never logged — only safe claims (aud, scp, exp, oid).
 */
var KOFC = KOFC || {};

KOFC.Auth = (function () {
    "use strict";

    // CONFIG holds ONLY generic, non-identity operational defaults so this file stays reusable
    // across orgs/buttons. All caller-specific values (tenantId, clientId, apiAppId, boomiUrl,
    // apiKey) are NULL here and MUST be supplied by KOFC.Auth.configure({...}) before use.
    // openEapp/callBoomi throw a clear error if a required value is still missing.
    var CONFIG = {
        // --- Required per caller; provide via configure() ---
        tenantId: null,
        clientId: null,
        apiAppId: null,
        boomiUrl: null,
        apiKey: null,

        // --- Generic defaults (override via configure() if needed) ---
        scope: "access_as_user",
        httpMethod: "POST",
        // MSAL redirect page (Entra SPA redirect URI). Set redirectUri to override the
        // "<origin>/WebResources/<redirectWebResource>" default. Case-sensitive in Entra.
        redirectUri: null,
        redirectWebResource: "kofc_authcallback.html",
        // D365 web resource name for the MSAL library (case-sensitive, no extension).
        msalWebResourcePath: "/WebResources/kofc_msalbrowsermin",
        // false = never show popup/redirect UI; fails with a clear message if silent auth can't complete.
        allowInteractive: false,
        // true = when silent (cache + ssoSilent) fails, do a FULL-PAGE redirect to Microsoft
        // sign-in (like kofc_BoomiIntegrationValidator). The callback page reads the code via
        // handleRedirectPromise and finishes the flow, so the next click is silent.
        allowRedirect: true,
        // Structured console logging for troubleshooting; enable via configure({ debug: true }).
        debug: false,
        // Max in-memory log entries kept for getLogs() / dumpLogs().
        logBufferSize: 100,
        // MSAL hidden-iframe timeouts (ms); raised above MSAL's ~6s default for slow D365 loads.
        iframeHashTimeout: 12000,
        loadFrameTimeout: 12000,
        // How many times to retry ssoSilent on a transient timed_out before giving up.
        ssoSilentRetries: 1
    };

    // Throws a clear error if required, caller-supplied config is missing (i.e. configure()
    // was not called or was incomplete). Keeps failures obvious instead of cryptic MSAL errors.
    function requireConfig(needBoomi) {
        var missing = [];
        if (!CONFIG.tenantId) { missing.push("tenantId"); }
        if (!CONFIG.clientId) { missing.push("clientId"); }
        if (!CONFIG.apiAppId) { missing.push("apiAppId"); }
        if (needBoomi && !CONFIG.boomiUrl) { missing.push("boomiUrl"); }
        if (needBoomi && !CONFIG.apiKey) { missing.push("apiKey"); }
        if (missing.length > 0) {
            throw new Error(
                "KOFC.Auth is not configured. Call KOFC.Auth.configure({ ... }) with: "
                + missing.join(", ") + " before use."
            );
        }
    }

    var LOG_PREFIX = "[KOFC.Auth]";
    var logBuffer = [];
    var correlationId = null;

    var msalApp = null;
    var msalLoad = null;
    var msalInitPromise = null;
    var tokenInProgress = null;

    function newCorrelationId() {
        return "eapp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }

    function log(level, step, data) {
        if (!CONFIG.debug && level !== "error") {
            return;
        }
        var entry = {
            ts: new Date().toISOString(),
            level: level,
            corr: correlationId,
            step: step,
            data: data || null
        };
        try {
            logBuffer.push(entry);
            while (logBuffer.length > (CONFIG.logBufferSize || 100)) {
                logBuffer.shift();
            }
        } catch (e) {
            // ignore buffer errors
        }

        if (typeof console === "undefined") {
            return;
        }
        var line = LOG_PREFIX + " " + level.toUpperCase() + " " + step
            + (correlationId ? " corr=" + correlationId : "");
        var fn = console.log;
        if (level === "error" && console.error) {
            fn = console.error;
        } else if (level === "warn" && console.warn) {
            fn = console.warn;
        } else if (level === "info" && console.info) {
            fn = console.info;
        }
        if (data !== undefined && data !== null) {
            fn.call(console, line, data);
        } else {
            fn.call(console, line);
        }
    }

    function getLogs() {
        return logBuffer.slice();
    }

    function clearLogs() {
        logBuffer = [];
        log("info", "logs.cleared", null);
        return { message: "Log buffer cleared." };
    }

    function dumpLogs() {
        var copy = getLogs();
        if (typeof console !== "undefined" && console.log) {
            console.log(LOG_PREFIX + " dump (" + copy.length + " entries)");
            console.log(JSON.stringify(copy, null, 2));
        }
        return copy;
    }

    function origin() {
        return window.location.origin;
    }

    function getRedirectUri() {
        return CONFIG.redirectUri
            || (origin() + "/WebResources/" + CONFIG.redirectWebResource);
    }

    var MSAL_CFG_KEY = "kofc_eapp_msal_cfg";
    // Pending EApp action persisted before a full-page redirect so the callback page can
    // finish the flow (call Boomi + open EApp) once sign-in returns — no second click.
    var PENDING_KEY = "kofc_eapp_pending";

    function persistPending(pending) {
        try {
            localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
            log("debug", "pending.persisted", { userId: pending.userId, oppId: pending.oppId });
        } catch (e) {
            log("warn", "pending.persist_failed", { reason: e && e.message ? e.message : "storage" });
        }
    }

    function clearPending() {
        try {
            localStorage.removeItem(PENDING_KEY);
        } catch (e) {
            // ignore
        }
    }

    function getReturnUrl() {
        // The D365 shell/form URL to come back to after a full-page redirect sign-in.
        try {
            return window.top.location.href;
        } catch (e) {
            return window.location.href;
        }
    }

    function persistMsalConfig() {
        try {
            localStorage.setItem(MSAL_CFG_KEY, JSON.stringify({
                clientId: CONFIG.clientId,
                tenantId: CONFIG.tenantId,
                redirectUri: getRedirectUri(),
                returnUrl: getReturnUrl()
            }));
            log("debug", "msal.config.persisted", { key: MSAL_CFG_KEY });
        } catch (e) {
            log("warn", "msal.config.persist_failed", { reason: e && e.message ? e.message : "storage" });
        }
    }

    function scopes() {
        return ["api://" + CONFIG.apiAppId + "/" + CONFIG.scope];
    }

    function getXrm() {
        if (typeof Xrm !== "undefined") {
            return Xrm;
        }
        try {
            if (window.parent && window.parent.Xrm) {
                return window.parent.Xrm;
            }
            if (window.top && window.top.Xrm) {
                return window.top.Xrm;
            }
        } catch (e) {
            // cross-origin frame access
        }
        return null;
    }

    function getD365Context() {
        try {
            if (typeof GetGlobalContext === "function") {
                return GetGlobalContext();
            }
        } catch (e) {
            // continue
        }
        var xrm = getXrm();
        if (xrm && xrm.Utility && xrm.Utility.getGlobalContext) {
            return xrm.Utility.getGlobalContext();
        }
        return null;
    }

    function buildNavigationClient() {
        var client = new msal.NavigationClient();
        client.navigateExternal = function (url) {
            try {
                var target = (window.self !== window.top) ? window.top : window;
                target.location.href = url;
            } catch (e) {
                window.location.href = url;
            }
            return Promise.resolve(true);
        };
        return client;
    }

    function loadMsal() {
        if (typeof msal !== "undefined") {
            log("debug", "msal.load.already_present", null);
            return Promise.resolve();
        }
        if (msalLoad) {
            log("debug", "msal.load.in_flight", null);
            return msalLoad;
        }
        var src = origin() + CONFIG.msalWebResourcePath;
        log("info", "msal.load.start", { src: src });
        msalLoad = new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = src;
            s.onload = function () {
                if (typeof msal !== "undefined") {
                    log("info", "msal.load.ok", null);
                    resolve();
                } else {
                    log("error", "msal.load.missing_global", { src: src });
                    reject(new Error("MSAL loaded but global 'msal' is undefined."));
                }
            };
            s.onerror = function () {
                log("error", "msal.load.failed", { src: src });
                reject(new Error("Failed to load MSAL web resource: " + src));
            };
            document.head.appendChild(s);
        });
        return msalLoad;
    }

    function buildMsalConfig() {
        var cfg = {
            auth: {
                clientId: CONFIG.clientId,
                authority: "https://login.microsoftonline.com/" + CONFIG.tenantId,
                redirectUri: getRedirectUri(),
                navigateToLoginRequestUrl: false
            },
            // localStorage: shared with the callback page; survives tab close.
            // See file header for lifetime and KOFC.Auth.clearCache() instructions.
            cache: {
                cacheLocation: "localStorage",
                storeAuthStateInCookie: true // helps iframe / Safari auth-state persistence
            },
            // Timeouts apply to the ssoSilent hidden iframe. Raised because D365 web resources
            // (CSP, wrappers, cold load) frequently exceed MSAL's ~6s default -> "timed_out".
            system: {
                iframeHashTimeout: CONFIG.iframeHashTimeout || 12000,
                loadFrameTimeout: CONFIG.loadFrameTimeout || 12000
            }
        };
        // NavigationClient + allowRedirectInIframe are needed only for the interactive redirect
        // or popup fallbacks (same as the validator). They let the redirect drive the TOP window
        // instead of navigating the hidden form iframe. Not added in pure silent mode.
        if (CONFIG.allowInteractive || CONFIG.allowRedirect) {
            cfg.system.allowRedirectInIframe = true;
            cfg.system.navigationClient = buildNavigationClient();
        }
        return cfg;
    }

    async function initMsal() {
        if (msalApp) {
            log("debug", "msal.init.reuse", null);
            return msalApp;
        }
        if (msalInitPromise) {
            log("debug", "msal.init.await_in_flight", null);
            return msalInitPromise;
        }

        log("info", "msal.init.start", {
            clientId: CONFIG.clientId,
            tenantId: CONFIG.tenantId,
            redirectUri: getRedirectUri(),
            allowInteractive: !!CONFIG.allowInteractive,
            scopes: scopes()
        });

        msalInitPromise = (async function () {
            await loadMsal();
            var app = new msal.PublicClientApplication(buildMsalConfig());
            await app.initialize();
            msalApp = app;
            persistMsalConfig();
            await msalApp.handleRedirectPromise();
            log("info", "msal.init.ok", {
                accountCount: msalApp.getAllAccounts().length
            });
            return msalApp;
        })();

        try {
            return await msalInitPromise;
        } catch (e) {
            msalApp = null;
            msalInitPromise = null;
            log("error", "msal.init.failed", { error: formatAuthError(e) });
            throw e;
        }
    }

    function pickAccount(accounts, loginHint) {
        if (!accounts || accounts.length === 0) {
            return null;
        }
        if (loginHint) {
            var hint = loginHint.toLowerCase();
            for (var i = 0; i < accounts.length; i++) {
                var username = (accounts[i].username || "").toLowerCase();
                if (username === hint) {
                    return accounts[i];
                }
            }
        }
        return accounts[0];
    }

    function isTimeout(err) {
        if (!err) {
            return false;
        }
        var code = "";
        try {
            code = String(err.errorCode || err.message || "");
        } catch (ignore) {
            code = "";
        }
        return code.indexOf("timed_out") >= 0
            || code.indexOf("monitor_window_timeout") >= 0
            || code.indexOf("iframe") >= 0 && code.indexOf("timeout") >= 0;
    }

    function formatAuthError(err) {
        if (!err) {
            return "unknown error";
        }
        try {
            if (err.errorCode) {
                return String(err.errorCode) + (err.subError ? " (" + err.subError + ")" : "");
            }
            if (err.message) {
                return String(err.message);
            }
        } catch (ignore) {
            // avoid circular/error getter recursion
        }
        return "authentication error";
    }

    /** Safe JWT claims only — never returns the raw token. */
    function tokenMeta(token) {
        try {
            var parts = (token || "").split(".");
            if (parts.length < 2) {
                return null;
            }
            var json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
            var claims = JSON.parse(json);
            return {
                aud: claims.aud || null,
                scp: claims.scp || null,
                roles: claims.roles || null,
                oid: claims.oid || null,
                tid: claims.tid || null,
                exp: claims.exp || null,
                expiresInSec: claims.exp ? (claims.exp - Math.floor(Date.now() / 1000)) : null
            };
        } catch (e) {
            return { parseError: true };
        }
    }

    async function getTokenInner(loginHint) {
        requireConfig(false);
        await initMsal();

        var scopeList = scopes();
        var lastError = null;

        log("info", "token.start", {
            loginHint: loginHint || null,
            scopes: scopeList,
            allowInteractive: !!CONFIG.allowInteractive
        });

        // 1) Silent from MSAL cache (same order as validator — works after any prior sign-in).
        var accounts = msalApp.getAllAccounts();
        var account = pickAccount(accounts, loginHint);
        log("debug", "token.accounts", {
            count: accounts.length,
            selected: account ? (account.username || account.homeAccountId || "(account)") : null
        });

        if (account) {
            try {
                log("info", "token.silent.try", { account: account.username || null });
                var silent = await msalApp.acquireTokenSilent({
                    scopes: scopeList,
                    account: account
                });
                log("info", "token.silent.ok", tokenMeta(silent.accessToken));
                return silent.accessToken;
            } catch (e) {
                lastError = e;
                log("warn", "token.silent.failed", { error: formatAuthError(e) });
            }
        } else {
            log("debug", "token.silent.skip", { reason: "no_cached_account" });
        }

        // 2) ssoSilent via hidden iframe — ONLY worth trying if MSAL can resolve the user
        //    silently, i.e. we have a cached account OR a loginHint (UPN). With neither,
        //    Entra can't pick a session in the hidden iframe and it just burns the full
        //    timeout ("timed_out / redirect_bridge_timeout"), so we skip straight to redirect.
        if (account || loginHint) {
            var ssoReq = { scopes: scopeList };
            if (loginHint) {
                ssoReq.loginHint = loginHint;
            }
            if (account) {
                ssoReq.account = account;
            }
            var attempts = (CONFIG.ssoSilentRetries || 0) + 1;
            for (var attempt = 1; attempt <= attempts; attempt++) {
                try {
                    log("info", "token.ssoSilent.try", {
                        loginHint: loginHint || null,
                        hasAccount: !!account,
                        attempt: attempt,
                        of: attempts
                    });
                    var sso = await msalApp.ssoSilent(ssoReq);
                    log("info", "token.ssoSilent.ok", tokenMeta(sso.accessToken));
                    return sso.accessToken;
                } catch (e) {
                    lastError = e;
                    log("warn", "token.ssoSilent.failed", {
                        error: formatAuthError(e),
                        attempt: attempt
                    });
                    // Only a timeout is worth retrying; other errors won't fix themselves.
                    if (!isTimeout(e) || attempt >= attempts) {
                        break;
                    }
                }
            }
        } else {
            log("info", "token.ssoSilent.skip", {
                reason: "no_account_and_no_loginHint",
                note: "ssoSilent cannot resolve a user silently; using redirect fallback."
            });
        }

        // 3) Full-page redirect fallback (mirrors the validator). Reliably fixes ssoSilent
        //    "timed_out": the callback page reads the code via handleRedirectPromise on return.
        //    This navigates away and does not return a token to THIS call — the returning page
        //    caches the token so the next click is silent.
        if (CONFIG.allowRedirect) {
            log("info", "token.redirect.start", {
                reason: formatAuthError(lastError),
                redirectUri: getRedirectUri()
            });
            var redirectReq = {
                scopes: scopeList,
                redirectStartPage: getRedirectUri()
            };
            if (loginHint) {
                redirectReq.loginHint = loginHint;
            }
            await msalApp.acquireTokenRedirect(redirectReq);
            // Page navigates away here; nothing after this runs.
            return null;
        }

        if (!CONFIG.allowInteractive) {
            var timedOut = isTimeout(lastError);
            log("error", "token.silent_only.exhausted", {
                lastError: formatAuthError(lastError),
                timedOut: timedOut,
                redirectUri: getRedirectUri(),
                loginHint: loginHint || null
            });
            throw new Error(
                "Silent sign-in failed (" + formatAuthError(lastError) + "). "
                + (timedOut
                    ? "timed_out = the silent hidden iframe never got the auth response. Most common causes: "
                      + "(1) third-party cookies are blocked (Edge/Chrome tracking-prevention) so the iframe "
                      + "cannot use your Entra session; (2) the redirect URI " + redirectWebResourceName()
                      + " is not registered in Entra (SPA) or 404s; (3) slow web-resource load. "
                      + "Try: allow third-party cookies for login.microsoftonline.com, verify the SPA redirect URI, "
                      + "then retry. For first-time consent set CONFIG.allowInteractive = true. "
                    : "Verify the redirect URI " + redirectWebResourceName() + " is registered in Entra (SPA), "
                      + "CONFIG tenantId/clientId/apiAppId match the validator, admin consent is granted, and "
                      + "loginHint (" + (loginHint || "none") + ") matches the user's Entra UPN. ")
                + "See console [KOFC.Auth] logs or KOFC.Auth.dumpLogs()."
            );
        }

        // 3) Interactive popup — only when allowInteractive is true.
        var popupReq = { scopes: scopeList, prompt: "select_account" };
        if (loginHint) {
            popupReq.loginHint = loginHint;
        }
        log("info", "token.popup.try", { loginHint: loginHint || null });
        var popup = await msalApp.acquireTokenPopup(popupReq);
        log("info", "token.popup.ok", tokenMeta(popup.accessToken));
        return popup.accessToken;
    }

    async function getToken(loginHint) {
        if (tokenInProgress) {
            log("debug", "token.await_in_flight", null);
            return tokenInProgress;
        }
        tokenInProgress = getTokenInner(loginHint).finally(function () {
            tokenInProgress = null;
        });
        return tokenInProgress;
    }

    function redirectWebResourceName() {
        return CONFIG.redirectWebResource || "kofc_authcallback.html";
    }

    function stripBraces(value) {
        return (value || "").replace(/[{}]/g, "").trim();
    }

    function buildUrl(userId, oppId) {
        var base = CONFIG.boomiUrl;
        if (!base) {
            throw new Error("CONFIG.boomiUrl is required.");
        }
        var qs = "userId=" + encodeURIComponent(userId);
        if (oppId) {
            qs += "&oppID=" + encodeURIComponent(oppId);
        }
        return base + (base.indexOf("?") >= 0 ? "&" : "?") + qs;
    }

    async function callBoomiApi(token, userId, oppId) {
        var method = (CONFIG.httpMethod || "POST").toUpperCase();
        var url = buildUrl(userId, oppId);
        log("info", "boomi.request.start", {
            method: method,
            url: url,
            userId: userId,
            oppID: oppId || null,
            hasApiKey: !!CONFIG.apiKey,
            token: tokenMeta(token)
        });

        var options = {
            method: method,
            headers: {
                "Authorization": "Bearer " + token,
                "x-api-key": CONFIG.apiKey,
                "Accept": "text/plain"
            }
        };
        if (method !== "GET" && method !== "HEAD") {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify({ userId: userId, oppID: oppId || undefined });
        }

        var response = await fetch(url, options);
        var body = await response.text();
        if (!response.ok) {
            log("error", "boomi.request.failed", {
                status: response.status,
                bodyPreview: (body || "").substring(0, 200)
            });
            throw new Error("Boomi returned " + response.status + ": " + body);
        }
        log("info", "boomi.request.ok", {
            status: response.status,
            bodyLength: (body || "").length,
            bodyPreview: (body || "").substring(0, 80)
        });
        return { status: response.status, body: body };
    }

    function deriveLoginHint() {
        try {
            var ctx = getD365Context();
            if (ctx && ctx.userSettings && ctx.userSettings.userName
                && ctx.userSettings.userName.indexOf("@") > 0) {
                return ctx.userSettings.userName;
            }
        } catch (e) {
            // continue
        }
        return null;
    }

    /**
     * Clears MSAL tokens/accounts and EApp callback config from localStorage, and resets
     * in-memory MSAL state. Use before re-testing silent auth (console: KOFC.Auth.clearCache()).
     * Does not clear Entra cookies — use InPrivate or clear login.microsoftonline.com cookies
     * if you also need a fresh SSO session.
     */
    function clearCache() {
        var removed = 0;
        try {
            var keys = [];
            for (var i = 0; i < localStorage.length; i++) {
                keys.push(localStorage.key(i));
            }
            keys.forEach(function (key) {
                if (!key) {
                    return;
                }
                if (key === MSAL_CFG_KEY || key === PENDING_KEY
                    || key.indexOf("msal.") === 0 || key.indexOf("msal-") === 0) {
                    localStorage.removeItem(key);
                    removed++;
                }
            });
        } catch (e) {
            log("warn", "cache.clear.storage_blocked", {
                reason: e && e.message ? e.message : "storage"
            });
        }

        msalApp = null;
        msalLoad = null;
        msalInitPromise = null;
        tokenInProgress = null;

        var msg = "EApp MSAL cache cleared (" + removed + " key(s)). Hard-refresh, then retry the button.";
        log("info", "cache.clear.ok", { removed: removed });
        return { removed: removed, message: msg };
    }

    // Config keys the caller may override at runtime via configure().
    var CONFIGURABLE_KEYS = [
        "tenantId", "clientId", "apiAppId", "scope",
        "boomiUrl", "httpMethod", "apiKey",
        "redirectUri", "redirectWebResource", "msalWebResourcePath",
        "allowInteractive", "allowRedirect",
        "debug", "logBufferSize",
        "iframeHashTimeout", "loadFrameTimeout", "ssoSilentRetries"
    ];
    // Changing any of these means the existing MSAL instance must be rebuilt.
    var AUTH_KEYS = { tenantId: 1, clientId: 1, redirectUri: 1, redirectWebResource: 1 };

    /**
     * Public: set configuration at runtime so this library is reusable across buttons/entities
     * without hard-coding credentials. Pass only the keys you want to override, e.g.:
     *
     *   KOFC.Auth.configure({
     *     tenantId: "...", clientId: "...", apiAppId: "...", scope: "access_as_user",
     *     boomiUrl: "https://.../ws/rest/...", apiKey: "...", httpMethod: "POST",
     *     redirectWebResource: "kofc_authcallback.html",
     *     msalWebResourcePath: "/WebResources/kofc_msalbrowsermin",
     *     allowRedirect: true, debug: false
     *   });
     *
     * Safe to call again; if an auth-related key changes, the MSAL instance is rebuilt.
     */
    function configure(options) {
        if (!options || typeof options !== "object") {
            return false;
        }
        var authChanged = false;
        CONFIGURABLE_KEYS.forEach(function (k) {
            if (options[k] !== undefined) {
                if (AUTH_KEYS[k] && options[k] !== CONFIG[k]) {
                    authChanged = true;
                }
                CONFIG[k] = options[k];
            }
        });
        if (authChanged) {
            // Force a fresh PublicClientApplication on next token request.
            msalApp = null;
            msalLoad = null;
            msalInitPromise = null;
        }
        log("info", "configure", { keys: Object.keys(options), authChanged: authChanged });
        return true;
    }

    // Public: acquire the delegated user access token (silent cache -> ssoSilent; popup only if allowInteractive).
    async function getAccessToken() {
        correlationId = newCorrelationId();
        log("info", "getAccessToken.start", null);
        return getToken(deriveLoginHint());
    }

    /**
     * Public: full EApp launch. Acquires the token, calls Boomi, and opens
     * eappUrl + "?soreq=<base64>" in a new tab.
     *
     * If silent auth isn't available and a full-page redirect is required, this persists the
     * intent (userId/oppId/eappUrl + Boomi params) so kofc_authcallback.html can finish the
     * flow automatically when sign-in returns — the user does NOT have to click the button again.
     *
     * Returns the opened SSO URL, or null when a redirect is in progress (callback will finish).
     */
    async function openEapp(userId, oppId, eappUrl) {
        correlationId = newCorrelationId();
        var uid = stripBraces(userId);
        var oid = stripBraces(oppId);
        log("info", "openEapp.start", { userId: uid, oppID: oid || null, hasEappUrl: !!eappUrl });

        requireConfig(true);
        if (!eappUrl) {
            throw new Error("openEapp requires the EApp base URL (kofc_EappURL).");
        }

        // Persist BEFORE requesting a token: if getToken triggers a redirect, the callback
        // page reads this to complete Boomi + open EApp on return.
        persistPending({
            userId: uid,
            oppId: oid,
            eappUrl: eappUrl,
            boomiUrl: CONFIG.boomiUrl,
            httpMethod: CONFIG.httpMethod || "POST",
            apiKey: CONFIG.apiKey,
            apiScopes: scopes()
        });

        var token = await getToken(deriveLoginHint());
        if (!token) {
            // Full-page redirect in progress; the callback page finishes using the pending intent.
            log("info", "openEapp.redirecting", null);
            return null;
        }

        var result = await callBoomiApi(token, uid, oid);
        clearPending();
        var ssoUrl = eappUrl + "?soreq=" + result.body;
        log("info", "openEapp.ok", { status: result.status });
        window.open(ssoUrl, "_blank");
        return ssoUrl;
    }

    // Public: acquire a token and call Boomi (CONFIG.boomiUrl), returning the raw response body.
    async function callBoomiRaw(userId, oppId) {
        correlationId = newCorrelationId();
        log("info", "callBoomiRaw.start", {
            userId: stripBraces(userId),
            oppID: stripBraces(oppId) || null
        });
        requireConfig(true);
        var token = await getToken(deriveLoginHint());
        if (!token) {
            // Redirect fallback navigated the page away; nothing more to do here.
            log("info", "callBoomiRaw.redirecting", null);
            return null;
        }
        var result = await callBoomiApi(
            token,
            stripBraces(userId),
            stripBraces(oppId)
        );
        log("info", "callBoomiRaw.ok", { status: result.status });
        return result.body;
    }

    // Entry point for the command bar button. Pass PrimaryControl as the parameter.
    async function callBoomi(primaryControl) {
        correlationId = newCorrelationId();
        try {
            var gctx = Xrm.Utility.getGlobalContext();
            var userId = stripBraces(gctx.userSettings.userId);
            var loginHint = deriveLoginHint();

            var oppId = "";
            if (primaryControl && primaryControl.data && primaryControl.data.entity
                && primaryControl.data.entity.getEntityName
                && primaryControl.data.entity.getEntityName() === "opportunity") {
                oppId = stripBraces(primaryControl.data.entity.getId());
            }

            log("info", "callBoomi.start", {
                userId: userId || null,
                oppID: oppId || null,
                loginHint: loginHint || null,
                entity: primaryControl && primaryControl.data && primaryControl.data.entity
                    && primaryControl.data.entity.getEntityName
                    ? primaryControl.data.entity.getEntityName()
                    : null
            });

            if (!userId) {
                throw new Error("Could not determine the current user's systemuserid.");
            }

            var token = await getToken(loginHint);
            if (!token) {
                // Redirect fallback is navigating to Microsoft sign-in; the returning
                // callback page completes and caches the token. Stop here.
                log("info", "callBoomi.redirecting", null);
                return null;
            }
            var result = await callBoomiApi(token, userId, oppId);

            log("info", "callBoomi.ok", { status: result.status });
            await Xrm.Navigation.openAlertDialog({
                title: "EApp SSO",
                text: "Boomi call succeeded (HTTP " + result.status + ")."
            });
            return result.body;
        } catch (e) {
            var message = (e && e.message) ? e.message : String(e);
            log("error", "callBoomi.failed", { message: message });
            if (Xrm.Navigation.openErrorDialog) {
                Xrm.Navigation.openErrorDialog({ message: "Boomi call failed: " + message });
            } else {
                Xrm.Navigation.openAlertDialog({ title: "EApp SSO - Error", text: message });
            }
        }
    }

    return {
        configure: configure,
        callBoomi: callBoomi,
        getAccessToken: getAccessToken,
        callBoomiRaw: callBoomiRaw,
        openEapp: openEapp,
        clearCache: clearCache,
        getLogs: getLogs,
        clearLogs: clearLogs,
        dumpLogs: dumpLogs
    };
})();
