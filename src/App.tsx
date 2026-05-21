import { useEffect, useMemo, useState } from "react";
import { Editor } from "./Editor.tsx";
import { Preview } from "./Preview.tsx";
import { DEFAULT_CONTENT, renderHtml, type SiteContent } from "./template.ts";
import {
    deployToBulletin,
    previewDeploy,
    type DeployPreview,
    type DeploySuccess,
} from "./deploy.ts";
import {
    type ActiveAccount,
    getDevAccount,
    hasInjectedExtension,
    tryExtensionAccount,
    tryHostAccount,
} from "./account.ts";

type DeployResult = DeployPreview | DeploySuccess;

export default function App() {
    const [content, setContent] = useState<SiteContent>(DEFAULT_CONTENT);
    const [domain, setDomain] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [result, setResult] = useState<DeployResult | null>(null);
    const [deployError, setDeployError] = useState<string | null>(null);

    const [useDev, setUseDev] = useState(false);
    const [hostAccount, setHostAccount] = useState<ActiveAccount | null>(null);
    const [extensionAccount, setExtensionAccount] = useState<ActiveAccount | null>(null);
    const [hostAttempted, setHostAttempted] = useState(false);
    const [hostError, setHostError] = useState<string | null>(null);
    const [extensionError, setExtensionError] = useState<string | null>(null);

    const devAccount = useMemo(() => getDevAccount(), []);
    const activeAccount: ActiveAccount | null = useDev
        ? devAccount
        : extensionAccount ?? hostAccount;

    useEffect(() => {
        tryHostAccount()
            .then((account) => {
                if (account) setHostAccount(account);
            })
            .catch((cause) => {
                setHostError(cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => setHostAttempted(true));
    }, []);

    const connectExtension = async () => {
        setExtensionError(null);
        try {
            const account = await tryExtensionAccount();
            if (account) {
                setExtensionAccount(account);
            } else {
                setExtensionError(
                    "No browser wallet found. Install Talisman, SubWallet, or Polkadot.js — or tick //Bob below.",
                );
            }
        } catch (cause) {
            setExtensionError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    const deploy = async () => {
        setBusy(true);
        setResult(null);
        setDeployError(null);
        setStatus(null);
        try {
            const html = renderHtml(content);
            // Only the //Bob path actually hits chain today. Host's signer is
            // stubbed; extension accounts may not have Bulletin authorization
            // — both fall back to a no-op preview.
            if (activeAccount?.source === "dev") {
                const stored = await deployToBulletin(html, domain || null, activeAccount, setStatus);
                setResult(stored);
            } else {
                const preview = await previewDeploy(html, domain || null);
                setResult(preview);
            }
        } catch (cause) {
            setDeployError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
            setStatus(null);
        }
    };

    const showStandaloneHints =
        hostAttempted && !hostAccount && !extensionAccount && !useDev;

    return (
        <>
            <header>
                <h1>hello-playground</h1>
                {activeAccount ? (
                    <span className={`address-chip source-${activeAccount.source}`}>
                        {activeAccount.displayName}
                    </span>
                ) : (
                    <span className="status-chip">
                        {hostAttempted ? "no signer" : "connecting…"}
                    </span>
                )}
            </header>

            <main>
                <section className="pane editor-pane">
                    <Editor value={content} onChange={setContent} />

                    <div className="deploy-bar">
                        <label className="field">
                            <span className="field-label">.dot name</span>
                            <input
                                type="text"
                                placeholder="auto-generated if blank"
                                value={domain}
                                onChange={(e) => setDomain(e.target.value.trim())}
                            />
                        </label>
                        <button
                            className="btn btn-primary"
                            onClick={deploy}
                            disabled={busy}
                        >
                            {busy ? "Deploying…" : "Deploy"}
                        </button>
                    </div>

                    <div className="signer-bar">
                        <label className="checkbox">
                            <input
                                type="checkbox"
                                checked={useDev}
                                onChange={(e) => setUseDev(e.target.checked)}
                            />
                            <span>Use //Bob — shared test account, no wallet needed</span>
                        </label>
                        {!useDev && !extensionAccount && hostAttempted && (
                            <button
                                className="btn btn-secondary"
                                onClick={connectExtension}
                                disabled={!hasInjectedExtension()}
                                title={
                                    hasInjectedExtension()
                                        ? "Connect Talisman, SubWallet, or Polkadot.js"
                                        : "No browser wallet detected"
                                }
                            >
                                Connect browser wallet
                            </button>
                        )}
                    </div>

                    {busy && status && <p className="status">{status}</p>}

                    {showStandaloneHints && (
                        <p className="hint">
                            Host signer not available — open in{" "}
                            <strong>Polkadot Desktop</strong> or{" "}
                            <strong>Polkadot Mobile</strong> to sign with your account,
                            connect a browser wallet, or tick the //Bob box to deploy
                            under a shared test account.
                        </p>
                    )}
                    {hostError && !hostAccount && (
                        <p className="hint subtle">Host: {hostError}</p>
                    )}
                    {extensionError && <p className="error">{extensionError}</p>}

                    {result && <ResultCard result={result} account={activeAccount} />}
                    {deployError && <pre className="error error-block">{deployError}</pre>}
                </section>

                <section className="pane preview-pane">
                    <Preview content={content} />
                </section>
            </main>
        </>
    );
}

function ResultCard({
    result,
    account,
}: {
    result: DeployResult;
    account: ActiveAccount | null;
}) {
    return (
        <div className={`result result-${result.kind}`}>
            <Row label="bytes">{result.bytes.toLocaleString()} B</Row>
            <Row label="CID" mono>
                {result.cid}
            </Row>
            <Row label="gateway">
                <a href={result.gatewayUrl} target="_blank" rel="noopener">
                    {result.gatewayUrl}
                </a>
            </Row>
            <Row label="would resolve to">
                <a
                    href={result.url}
                    target="_blank"
                    rel="noopener"
                    onClick={(e) => e.preventDefault()}
                >
                    {result.url}
                </a>
            </Row>
            <Row label="signed by">
                {account ? `${account.displayName} (${account.source})` : "— no signer —"}
            </Row>
            {result.kind === "stored" ? (
                <>
                    <Row label="block">
                        #{result.blockNumber.toLocaleString()} tx[{result.txIndex}]
                    </Row>
                    <p className="result-note success">
                        Stored on Bulletin Chain. Fetch the bytes via the gateway link above.
                        DotNS register (the <code>.dot.li</code> mapping) is not wired yet.
                    </p>
                </>
            ) : (
                <p className="result-note">
                    Preview only — chain submission for {account?.source ?? "this signer"} is not
                    wired. Tick the //Bob box to do an end-to-end deploy.
                </p>
            )}
        </div>
    );
}

function Row({
    label,
    children,
    mono,
}: {
    label: string;
    children: React.ReactNode;
    mono?: boolean;
}) {
    return (
        <div className="row-line">
            <span className="row-label">{label}</span>
            <span className={`row-value${mono ? " mono" : ""}`}>{children}</span>
        </div>
    );
}
