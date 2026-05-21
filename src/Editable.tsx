// Inline contenteditable primitive. State drives the deploy artifact; the DOM
// is the editing surface; the two are kept in sync via refs without React
// fighting the user's cursor on every keystroke.
//
// Key design: we DON'T pass `value` as React children. The DOM owns its own
// text until either (a) the parent rerenders us with a different `value` that
// originated externally (e.g. reset), or (b) the user types. The `lastSeen`
// ref tracks the value we last echoed in/out, so external resets sync but
// echoes from our own onInput don't trigger a redundant DOM write that would
// nuke the caret position.

import {
    createElement,
    useEffect,
    useRef,
    type CSSProperties,
    type FormEvent,
} from "react";

interface EditableProps {
    tag: keyof HTMLElementTagNameMap;
    value: string;
    onChange: (next: string) => void;
    /** When false, renders as a plain element with no editing affordances — the
     * exact same DOM the deploy artifact will contain. */
    editable: boolean;
    style?: CSSProperties;
    className?: string;
    placeholder?: string;
    ariaLabel?: string;
}

export function Editable({
    tag,
    value,
    onChange,
    editable,
    style,
    className,
    placeholder,
    ariaLabel,
}: EditableProps) {
    const ref = useRef<HTMLElement>(null);
    const lastSeen = useRef(value);

    // First mount: populate the DOM with the initial value.
    useEffect(() => {
        if (ref.current && ref.current.textContent !== value) {
            ref.current.textContent = value;
        }
        lastSeen.current = value;
        // run once on mount only — subsequent external syncs handled below
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Sync when `value` changes externally (i.e. not from our own onInput).
    useEffect(() => {
        if (value === lastSeen.current) return;
        if (ref.current && ref.current.textContent !== value) {
            ref.current.textContent = value;
        }
        lastSeen.current = value;
    }, [value]);

    const onInput = (e: FormEvent<HTMLElement>) => {
        const next = e.currentTarget.textContent ?? "";
        lastSeen.current = next;
        onChange(next);
    };

    // Preview render: no editing affordances at all. Same DOM the deploy
    // artifact uses — what you see is exactly what gets shipped.
    if (!editable) {
        return createElement(
            tag,
            {
                ref,
                className,
                style,
            },
            value,
        );
    }

    return createElement(tag, {
        ref,
        contentEditable: "plaintext-only",
        suppressContentEditableWarning: true,
        onInput,
        className: ["editable", className].filter(Boolean).join(" "),
        style,
        "aria-label": ariaLabel,
        "data-placeholder": placeholder,
        spellCheck: true,
    });
}
