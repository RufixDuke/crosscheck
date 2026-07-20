/**
 * Minimal local type declaration for picomatch v4 — the package ships no
 * bundled types and @types/picomatch is not in the dependency set. Covers
 * the API surface CrossCheck uses (glob → matcher function, `dot` option);
 * extend here if more of the API is ever needed.
 */
declare module "picomatch" {
  interface PicomatchOptions {
    basename?: boolean;
    bash?: boolean;
    capture?: boolean;
    contains?: boolean;
    cwd?: string;
    debug?: boolean;
    dot?: boolean;
    expandRange?: (a: string, b: string) => string;
    failglob?: boolean;
    fastpaths?: boolean;
    flags?: string;
    format?: (str: string) => string;
    ignore?: string | string[];
    keepQuotes?: boolean;
    literalBrackets?: boolean;
    lookbehinds?: boolean;
    matchBase?: boolean;
    maxLength?: number;
    nobrace?: boolean;
    nobracket?: boolean;
    nocase?: boolean;
    nodupes?: boolean;
    noext?: boolean;
    noextglob?: boolean;
    noglobstar?: boolean;
    nonegate?: boolean;
    noquantifiers?: boolean;
    onIgnore?: (result: unknown) => void;
    onMatch?: (result: unknown) => void;
    partial?: boolean;
    posix?: boolean;
    posixSlashes?: boolean;
    prepend?: boolean;
    regex?: boolean;
    strictBrackets?: boolean;
    strictSlashes?: boolean;
    unescape?: boolean;
    unixify?: boolean;
  }

  type PicomatchMatcher = (test: string) => boolean;

  function picomatch(
    globs: string | string[],
    options?: PicomatchOptions,
  ): PicomatchMatcher;

  namespace picomatch {
    function isMatch(
      str: string,
      patterns: string | string[],
      options?: PicomatchOptions,
    ): boolean;
    function matchBase(
      input: string,
      glob: string | RegExp,
      options?: PicomatchOptions,
    ): boolean;
    function test(
      input: string,
      regex: RegExp,
      options?: PicomatchOptions,
    ): { isMatch: boolean; output: string };
    function parse(pattern: string, options?: PicomatchOptions): Record<string, unknown>;
    function scan(input: string, options?: PicomatchOptions): Record<string, unknown>;
    function toRegex(source: string | string[], options?: PicomatchOptions): RegExp;
  }

  export = picomatch;
}
