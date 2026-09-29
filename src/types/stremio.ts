export interface StremioManifestResource {
  name: string;
  types: string[];
  idPrefixes?: string[];
  /** Extra arguments the player may send with the request (Stremio protocol) */
  extra?: Array<{ name: string; isRequired?: boolean }>;
}

export interface StremioManifestBehaviorHints {
  configurable?: boolean;
  configurationRequired?: boolean;
}

export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  logo?: string;
  background?: string;
  resources: (string | StremioManifestResource)[];
  types: string[];
  catalogs: unknown[];
  behaviorHints?: StremioManifestBehaviorHints;
}

export interface StremioSubtitle {
  id: string;
  url: string;
  lang: string;
  title?: string;
}

export interface StremioSubtitlesResponse {
  subtitles: StremioSubtitle[];
}
