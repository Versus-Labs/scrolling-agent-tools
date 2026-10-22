import { InvalidArgumentError, type Command } from "commander";
import type { Context } from "../context.js";
import { usageError } from "../exit-codes.js";
import { formatCreators } from "./format.js";
import { act, compact, fileIds, many, startJob, withSpendOptions, withWaitOptions } from "./shared.js";

/*
 * The choices a new Creator takes. These mirror CREATOR_FROM, CREATOR_KINDS, CREATOR_GENDERS,
 * CREATOR_AGES, CREATOR_OUTFITS, CREATOR_ENERGIES, CREATOR_VOICES, CREATOR_ACCENTS and the limits of
 * CreateCreatorInput in the app's src/lib/public-api/schemas.ts. This package can't import app
 * code, so keep them in step by hand: the server checks them again either way (a value it doesn't
 * know is a 400, exit 2).
 */
export const CREATOR_FROM = ["description", "photo", "photos"] as const;
export const CREATOR_KINDS = ["person", "extreme", "creature", "alien", "insect", "frog", "cat", "dog", "bird", "rodent"] as const;
export const CREATOR_GENDERS = ["woman", "man", "non-binary"] as const;
export const CREATOR_AGES = ["18-24", "25-34", "35-44", "45-54", "55+"] as const;
export const CREATOR_OUTFITS = ["casual", "sporty", "smart", "cozy", "streetwear", "workwear"] as const;
export const CREATOR_ENERGIES = ["calm", "warm", "upbeat", "direct", "playful", "expert"] as const;
export const CREATOR_VOICES = ["soft", "warm", "bright", "deep", "raspy"] as const;
export const CREATOR_ACCENTS = ["american", "british", "australian", "irish", "spanish", "french"] as const;
export const CREATOR_NAME_MAX = 40;
export const CREATOR_DESCRIPTION_MAX = 300;
export const CREATOR_MAX_ENERGIES = 2;
export const CREATOR_MAX_PHOTOS = 3;

type From = (typeof CREATOR_FROM)[number];

/** How someone looks: a photo already says it. */
const LOOK_FLAGS = ["kind", "gender", "age", "outfit"] as const;
/** Every choice: the look, then how they come across and sound. */
const CHOICE_FLAGS = [...LOOK_FLAGS, "energy", "voice", "accent"] as const;
type ChoiceFlag = (typeof CHOICE_FLAGS)[number];

function choiceArg(flag: string, allowed: readonly string[]) {
  return (raw: string): string => {
    const v = raw.trim().toLowerCase();
    if (!allowed.includes(v)) throw new InvalidArgumentError(`${flag} is one of ${allowed.join(", ")}.`);
    return v;
  };
}

/** --energy: repeatable, or comma-separated (--energy warm,playful). */
function energyList(value: string, previous: string[] = []): string[] {
  const check = choiceArg("--energy", CREATOR_ENERGIES);
  return [...previous, ...value.split(",").map((s) => s.trim()).filter(Boolean).map(check)];
}

/**
 * The server's rules (CreateCreatorInput's refinements), checked before anything is uploaded or
 * sent, so a wrong combination is a clear exit 2. Returns how the Creator is made: without
 * --from and without photos, designed from a description.
 */
export function checkCreatorFlags(o: Record<string, unknown>): From {
  const name = String(o.name ?? "").trim();
  if (!name) throw usageError("Give the Creator a --name.");
  if (name.length > CREATOR_NAME_MAX) throw usageError(`--name is at most ${CREATOR_NAME_MAX} characters.`);
  const description = (o.description as string | undefined)?.trim();
  if (description && description.length > CREATOR_DESCRIPTION_MAX) throw usageError(`--description is at most ${CREATOR_DESCRIPTION_MAX} characters.`);
  const energy = (o.energy as string[] | undefined) ?? [];
  if (energy.length > CREATOR_MAX_ENERGIES) throw usageError(`Give at most ${CREATOR_MAX_ENERGIES} --energy.`);
  if (new Set(energy).size !== energy.length) throw usageError("Give each --energy once.");

  const photos = ((o.photo as string[] | undefined) ?? []).length;
  const given = (f: ChoiceFlag) => (f === "energy" ? energy.length > 0 : o[f] !== undefined);
  const named = (fs: readonly ChoiceFlag[]) => fs.filter(given).map((f) => `--${f}`);
  const from = o.from as From | undefined;

  if (from === undefined) {
    if (photos > 0) throw usageError("With --photo, say --from photo (one photo, built and charged) or --from photos (1–3 photos used as they are, free).");
    return "description";
  }
  if (from === "description") {
    if (photos > 0) throw usageError("A Creator designed from a description takes no --photo: use --from photo or --from photos.");
  } else if (from === "photo") {
    if (photos !== 1) throw usageError("--from photo takes exactly one --photo of them.");
    const look = named(LOOK_FLAGS);
    if (look.length) throw usageError(`From a photo, how they look is the photo's: leave out ${look.join(", ")}.`);
  } else {
    if (photos < 1 || photos > CREATOR_MAX_PHOTOS) throw usageError(`--from photos takes 1 to ${CREATOR_MAX_PHOTOS} --photo of them.`);
    if (description) throw usageError("--from photos uses the photos as they are: leave out --description.");
    const choices = named(CHOICE_FLAGS);
    if (choices.length) throw usageError(`--from photos uses the photos as they are: leave out ${choices.join(", ")}.`);
  }
  return from;
}

export function registerCreators(program: Command, ctx: Context): void {
  const creators = program.command("creators").description("Creators (cr_…): the people who appear in your videos; list them or make your own");
  creators
    .command("list")
    .description("list Creators: the library and your brands' own")
    .option("--brand <brd_id>", "only this brand's own Creators (plus the library)")
    .addHelpText("after", "\nExample:\n  $ scrolling creators list --brand brd_abc123 --json")
    .action(
      act(ctx, async (rt, _args, o) => {
        const api = await rt.api();
        const d = await api.get<Parameters<typeof formatCreators>[0]>("/creators", { query: { brand_id: o.brand as string | undefined } });
        rt.out.result(d, { human: formatCreators, quiet: (c) => c.creators.map((x) => x.id).join("\n") });
      }),
    );

  const create = creators
    .command("create")
    .description("make a new Creator for a brand: designed or from one photo (charged, minutes), or from 1–3 photos (free, at once)")
    .requiredOption("--brand <brd_id>", "the brand it is for")
    .requiredOption("--name <name>", `what they're called ("@Name" in ideas and scripts; up to ${CREATOR_NAME_MAX} characters)`)
    .option("--from <how>", "description (the default: designed from your choices), photo (built from one photo) or photos (1–3 photos used as they are: free, no voice of their own, Create only)", choiceArg("--from", CREATOR_FROM))
    .option("--description <text>", `who they are, in your words (description and photo; up to ${CREATOR_DESCRIPTION_MAX} characters)`)
    .option("--kind <kind>", `description only: ${CREATOR_KINDS.join(", ")}`, choiceArg("--kind", CREATOR_KINDS))
    .option("--gender <g>", `description only: ${CREATOR_GENDERS.join(", ")}`, choiceArg("--gender", CREATOR_GENDERS))
    .option("--age <range>", `description only: ${CREATOR_AGES.join(", ")}`, choiceArg("--age", CREATOR_AGES))
    .option("--outfit <style>", `description only: ${CREATOR_OUTFITS.join(", ")}`, choiceArg("--outfit", CREATOR_OUTFITS))
    .option("--energy <e>", `up to ${CREATOR_MAX_ENERGIES} (repeat or comma-separate): ${CREATOR_ENERGIES.join(", ")}`, energyList)
    .option("--voice <v>", `description and photo: ${CREATOR_VOICES.join(", ")}`, choiceArg("--voice", CREATOR_VOICES))
    .option("--accent <a>", `description and photo: ${CREATOR_ACCENTS.join(", ")}`, choiceArg("--accent", CREATOR_ACCENTS))
    .option("--photo <file|url|file_id>", `a photo of them (repeat; photo: exactly 1, photos: 1–${CREATOR_MAX_PHOTOS})`, many);
  withSpendOptions(create);
  withWaitOptions(create);
  create.addHelpText(
    "after",
    `
Examples:
  $ scrolling cost creator                                       # the price; nothing is spent
  $ scrolling creators create --brand brd_abc --name Mei --gender woman --age 25-34 --energy warm,playful \\
      --description 'Runs a small bakery, laughs easily' --yes --wait
  $ scrolling creators create --brand brd_abc --name Sam --from photo --photo ./sam.jpg --voice deep --yes --wait
  $ scrolling creators create --brand brd_abc --name Ana --from photos --photo a.jpg --photo b.jpg   # free, ready at once

The job id is the new Creator's cr_… id: follow it with \`scrolling jobs wait cr_…\`, then use it
with \`scrolling create --creator cr_…\`. A Creator from photos has no voice of its own and works
in Create only. Designed and from-a-photo Creators are charged: without --yes (or --max-credits)
and without a terminal nothing is spent; the estimate is printed and the exit code is 9.`,
  );
  create.action(
    act(ctx, async (rt, _a, o) => {
      const from = checkCreatorFlags(o);
      const api = await rt.api();
      const energy = o.energy as string[] | undefined;
      const body = compact({
        brand_id: o.brand,
        name: (o.name as string).trim(),
        from,
        description: (o.description as string | undefined)?.trim() || undefined,
        kind: o.kind,
        gender: o.gender,
        age: o.age,
        outfit: o.outfit,
        energy: energy?.length ? energy : undefined,
        voice: o.voice,
        accent: o.accent,
        photo_file_ids: await fileIds(rt, api, o.photo as string[] | undefined),
      });
      // From photos is free: no estimate (it consents to 0 credits). Designed or from a photo: one price.
      await startJob(rt, api, "/creators", body, o, from === "photos" ? undefined : { kind: "creator" });
    }),
  );
}
