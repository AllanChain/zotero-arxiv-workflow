import { type Fetcher, requestBounded } from "./base";
import { makeChallengeFetcher } from "./challenge";

export type { Fetcher };

/** Production fetcher: bounded requests with challenge handling pre-applied. */
export const defaultFetcher: Fetcher = makeChallengeFetcher(requestBounded);
