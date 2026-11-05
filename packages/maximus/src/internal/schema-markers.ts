/**
 * The markers input codecs leave on a schema, which the codecs and the reader of secret fields share.
 */

/** Whether an object drops unknown keys when read with `stripUnknown`. */
export const STRIP = Symbol('maximus.schema.strip');
/** The source schema of a `pipeSchema`, which the wire value is first read as. */
export const SOURCE = Symbol('maximus.schema.source');
