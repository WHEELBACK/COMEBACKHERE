/**
 * Dictionary type — every language file must satisfy this shape.
 * Derived directly from the `en` dictionary so that the type is
 * always up-to-date: adding a key to `en.ts` automatically requires
 * it in every other language file.
 */
import en from "./en"

export type Dictionary = typeof en
