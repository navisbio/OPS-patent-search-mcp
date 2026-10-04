import { z } from "zod";

export const documentNumberParam = z
  .string()
  .describe('Patent publication number, e.g. "EP1000000"');

export const inputFormatParam = z
  .enum(["epodoc", "docdb", "original"])
  .default("epodoc")
  .describe("Number format");

export const fallbackToFamilyParam = z
  .boolean()
  .default(true)
  .describe(
    "If full text is not available for this document, automatically try family members (EP/WO preferred). Default true."
  );
