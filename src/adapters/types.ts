export interface ChatRequest {
  system: string;
  user: string;
  /** Immagini allegate (JPEG in base64, senza prefisso): le riceve solo chi ne è idoneo (voci Gemini). */
  images?: string[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Un modello della catena non ha risposto in tempo o non esiste più (per spostarlo in fondo). */
  onModelFail?: (model: string) => void;
  /** Ricerca sul web: strumenti di ricerca di Claude o browser_search di Groq (solo GPT-OSS). */
  webSearch?: boolean;
  /** Tempo massimo per un singolo tentativo (al posto di quello predefinito dell'adapter). */
  timeoutMs?: number;
  /**
   * Streaming: riceve il testo visibile accumulato del tentativo in corso a ogni pezzo nuovo, con il
   * modello che lo sta scrivendo. Un testo che non prolunga il precedente (es. "" quando un tentativo
   * fallisce a metà e riparte una riserva) sostituisce quello mostrato. Senza callback niente streaming.
   */
  onText?: (text: string, model: string) => void;
  /** Streaming: tempo massimo senza alcun dato dal provider (prima del primo pezzo o tra due pezzi). */
  idleMs?: number;
}

export interface ChatResult {
  text: string;
  ms: number;
  /** Modello che ha risposto davvero (può essere una riserva). */
  model?: string;
  /** Modello che doveva rispondere e non l'ha fatto, se ha risposto una riserva. */
  replaced?: string;
}
