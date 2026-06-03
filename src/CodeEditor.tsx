// CodeMirror 6 wrapper for the markdown/html source editors. Loaded via
// React.lazy from App.tsx so the whole CodeMirror bundle lives in its own
// chunk — block-editor users never download it.
//
// CM6 is the mobile-correct choice here: it was rewritten specifically for
// touch/IME support, and it disables autocorrect/autocapitalize on its
// content element by default.
//
// Undo durability: views are destroyed on pane/view switches, so each pane's
// state (doc + selection + UNDO HISTORY) is serialized into a module-level
// cache on teardown and restored on the next mount. Extensions are always
// rebuilt fresh — only the serializable fields are cached — so no stale
// closures survive a remount. External doc changes are dispatched into the
// restored state, which makes even a re-conversion undoable.

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
    EditorView,
    keymap,
    lineNumbers,
    placeholder as cmPlaceholder,
} from "@codemirror/view";
import {
    defaultKeymap,
    history,
    historyField,
    historyKeymap,
    indentWithTab,
    redo,
    redoDepth,
    undo,
    undoDepth,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";

export type CodeLanguage = "html" | "css" | "js" | "markdown";

/** Imperative undo/redo access for the action-bar buttons (mobile has no ⌘Z). */
export interface EditorHandle {
    undo: () => void;
    redo: () => void;
    canUndo: () => boolean;
    canRedo: () => boolean;
}

const LANGUAGES: Record<CodeLanguage, () => ReturnType<typeof html>> = {
    html: () => html(),
    css: () => css(),
    js: () => javascript(),
    markdown: () => markdown(),
};

const HISTORY_FIELDS = { history: historyField };
// Serialized EditorState JSON per pane, surviving unmounts for the session.
const stateCache = new Map<CodeLanguage, unknown>();

export default function CodeEditor({
    language,
    value,
    onChange,
    ariaLabel,
    placeholder,
    onHandle,
}: {
    language: CodeLanguage;
    value: string;
    onChange: (next: string) => void;
    ariaLabel: string;
    placeholder?: string;
    onHandle?: (handle: EditorHandle | null) => void;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Refs so the view (created once per language) always sees the latest
    // callback/value without being torn down on every keystroke's re-render.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const valueRef = useRef(value);
    valueRef.current = value;
    const onHandleRef = useRef(onHandle);
    onHandleRef.current = onHandle;

    // (Re)create the view when the pane/language changes, restoring that
    // pane's cached history when there is one.
    useEffect(() => {
        if (!hostRef.current) return;
        const extensions = [
            lineNumbers(),
            history(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            EditorView.lineWrapping,
            oneDark,
            LANGUAGES[language](),
            ...(placeholder ? [cmPlaceholder(placeholder)] : []),
            keymap.of([
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...historyKeymap,
                indentWithTab,
            ]),
            EditorView.updateListener.of((update) => {
                if (update.docChanged)
                    onChangeRef.current(update.state.doc.toString());
            }),
            EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
        ];

        let state: EditorState | null = null;
        const cached = stateCache.get(language);
        if (cached) {
            try {
                state = EditorState.fromJSON(cached, { extensions }, HISTORY_FIELDS);
                const doc = state.doc.toString();
                if (doc !== valueRef.current) {
                    // App state moved while unmounted (e.g. re-convert):
                    // dispatch the difference so it lands IN the history.
                    state = state.update({
                        changes: { from: 0, to: doc.length, insert: valueRef.current },
                    }).state;
                }
            } catch {
                state = null; // corrupt cache entry — fall through to fresh
            }
        }
        if (!state) {
            state = EditorState.create({ doc: valueRef.current, extensions });
        }

        const view = new EditorView({ state, parent: hostRef.current });
        viewRef.current = view;
        onHandleRef.current?.({
            undo: () => undo(view),
            redo: () => redo(view),
            canUndo: () => undoDepth(view.state) > 0,
            canRedo: () => redoDepth(view.state) > 0,
        });
        return () => {
            stateCache.set(language, view.state.toJSON(HISTORY_FIELDS));
            onHandleRef.current?.(null);
            view.destroy();
            viewRef.current = null;
        };
    }, [language, placeholder, ariaLabel]);

    // External value changes (e.g. re-converting) sync into the live view.
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        const current = view.state.doc.toString();
        if (current !== value) {
            view.dispatch({
                changes: { from: 0, to: current.length, insert: value },
            });
        }
    }, [value]);

    return <div ref={hostRef} className="code-editor-host" />;
}
