import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type {
    BusinessPlanPayload,
    BusinessPlanToExtensionMessage,
    ExtensionToBusinessPlanMessage,
} from '../../../src/protocol/businessPlan';
import { BusinessPlanApp, type BusinessPlanNotice } from './BusinessPlanApp';

declare const acquireVsCodeApi: () => { postMessage: (message: unknown) => void };
const vscode = acquireVsCodeApi();

function Root() {
    const [payload, setPayload] = useState<BusinessPlanPayload | null>(null);
    const [notice, setNotice] = useState<BusinessPlanNotice | null>(null);

    const send = useCallback((message: BusinessPlanToExtensionMessage) => {
        vscode.postMessage(message);
    }, []);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const msg = event.data as ExtensionToBusinessPlanMessage | undefined;
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'state') {
                setPayload(msg.payload);
            } else if (msg.type === 'notice') {
                setNotice({ tone: msg.tone, text: msg.text });
            }
        };

        window.addEventListener('message', onMessage);
        vscode.postMessage({ type: 'ready' });
        return () => window.removeEventListener('message', onMessage);
    }, []);

    return (
        <BusinessPlanApp
            payload={payload}
            notice={notice}
            onDismissNotice={() => setNotice(null)}
            send={send}
        />
    );
}

const mount = document.getElementById('app-root') ?? document.getElementById('root');
if (mount) {
    render(<Root />, mount);
}
