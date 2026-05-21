export interface ThemeMetaResponse {
  owner: string;
  created_at: number;
  size: number;
}

export interface ChallengeRequest {
  address: string;
}

export interface ChallengeResponse {
  nonce: string;
  expires_in: number;
}

export interface SaveThemeResponse {
  hash: string;
  url: string;
}

export interface ListOwnerThemesResponse {
  address: string;
  hashes: string[];
  next_offset: number | null;
}

export interface ErrorResponse {
  error: string;
}
