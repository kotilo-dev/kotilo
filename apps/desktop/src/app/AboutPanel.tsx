/**
 * Shared About content (faz7-spec §11, revised §12) — mounted in TWO places: the top of
 * Settings → About (`SettingsModal.tsx`) and the Help modal's fourth "About" item
 * (`src/features/help/HelpModal.tsx`). Self-contained: fetches `app_info()` itself so either
 * host can just render `<AboutPanel />` with no props.
 */
import { useEffect, useState, type ReactNode } from "react";
import appIcon from "../assets/app-icon.png";
import { useStrings } from "./strings";
import { CONTACT_EMAIL, CREDITS, projectLinks } from "./about";
import { collectDiagnostics } from "./diagnosticsActions";
import { Button } from "./ui/Button";
import { LicensesViewer } from "./LicensesViewer";
import { UpdateCheck } from "../features/update/UpdateCheck";
import { appInfo, clipboardWriteText, openExternalUrl, type AppInfo } from "../lib/ipc";
import { useToastStore } from "../stores/toastStore";
import { webviewName } from "../lib/platform";

const LINK_CLASS = "text-accent underline";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href="#"
      className={LINK_CLASS}
      onClick={(e) => {
        e.preventDefault();
        void openExternalUrl(href);
      }}
      onAuxClick={(e) => {
        e.preventDefault();
        void openExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
}

export function AboutPanel() {
  const strings = useStrings();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [collecting, setCollecting] = useState(false);
  const links = projectLinks();

  useEffect(() => {
    let cancelled = false;
    void appInfo()
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch(() => {
        // Left as null — the panel still renders (description/contact/credits work without it).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function copyEmail() {
    void clipboardWriteText(CONTACT_EMAIL).then(() => useToastStore.getState().show(strings.toast.emailCopied));
  }

  function copyVersionInfo() {
    if (!info) return;
    void clipboardWriteText(strings.about.versionInfoBlock(info)).then(() =>
      useToastStore.getState().show(strings.toast.versionInfoCopied),
    );
  }

  return (
    <section aria-label={strings.appName} className="flex flex-col gap-3 text-xs text-text">
      <div className="flex items-center gap-3">
        <img src={appIcon} alt={strings.about.iconAlt} width={64} height={64} className="shrink-0" />
        <div>
          <div className="text-sm font-semibold">{strings.appName}</div>
          {info ? (
            <>
              <div className="text-muted">{strings.about.version(info.version, info.gitSha)}</div>
              <div className="text-muted">{strings.about.buildDate(info.buildDate)}</div>
            </>
          ) : (
            <div className="text-muted">{strings.about.loading}</div>
          )}
        </div>
      </div>

      <p>{strings.about.description}</p>
      <p className="font-medium">{strings.update.license}</p>

      {links && (
        <nav aria-label={strings.update.linksLabel} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ExternalLink href={links.repository}>{strings.update.repository}</ExternalLink>
          <ExternalLink href={links.issues}>{strings.update.issues}</ExternalLink>
          <ExternalLink href={links.discussions}>{strings.update.discussions}</ExternalLink>
        </nav>
      )}

      <UpdateCheck />

      {CONTACT_EMAIL && (
        <div className="flex items-center gap-2">
          <span className="text-muted">{strings.about.contactLabel}</span>
          <a
            href="#"
            className={LINK_CLASS}
            onClick={(e) => {
              e.preventDefault();
              void openExternalUrl(`mailto:${CONTACT_EMAIL}`);
            }}
          >
            {CONTACT_EMAIL}
          </a>
        </div>
      )}

      <p>{strings.about.reportingProblem}</p>
      {info && (
        <span className="text-muted">
          {strings.about.webview(webviewName(info.platform), info.webview2)} · {strings.about.os(info.os)}
        </span>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={collecting}
          onClick={() => {
            setCollecting(true);
            void collectDiagnostics().finally(() => setCollecting(false));
          }}
        >
          {strings.about.collectDiagnostics}
        </Button>
        {info && <Button onClick={copyVersionInfo}>{strings.about.copyVersionInfo}</Button>}
        {CONTACT_EMAIL && <Button onClick={copyEmail}>{strings.about.copyEmail}</Button>}
      </div>

      <div className="text-muted">
        {strings.about.creditsIntro}
        {CREDITS.map((c, i) => (
          <span key={c.name}>
            {i > 0 && (i === CREDITS.length - 1 ? strings.about.creditsAnd : ", ")}
            <ExternalLink href={c.href}>{c.name}</ExternalLink>
          </span>
        ))}
        {strings.about.creditsOutro}
      </div>

      <p className="text-muted">{strings.update.notAffiliated}</p>

      <LicensesViewer />
    </section>
  );
}
