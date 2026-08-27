"""
Translator module for VideoRAG
Converts Hindi transcripts to English before RAG processing.
Keeps existing RAG logic untouched — only pre-processes the transcript string.
"""
import re
from dotenv import load_dotenv

load_dotenv()

# Lazy-loaded translator LLM (same model as RAG to avoid new dependencies)
_translator_llm = None

def _get_translator_llm():
    global _translator_llm
    if _translator_llm is None:
        from langchain_groq import ChatGroq
        _translator_llm = ChatGroq(
            model="openai/gpt-oss-120b",
            temperature=0
        )
    return _translator_llm

def contains_hindi(text: str) -> bool:
    """Return True if text contains Devanagari (Hindi) characters."""
    if not text:
        return False
    return bool(re.search(r'[\u0900-\u097F]', text))

def translate_hindi_to_english(text: str, chunk_size: int = 3500) -> str:
    """
    Translate Hindi text to English using Groq LLM.
    Splits long text into chunks to stay within token limits.
    If translation fails for a chunk, keeps original chunk.
    """
    if not text or not text.strip():
        return text
    if not contains_hindi(text):
        return text

    print("Translating Hindi transcript to English...")

    llm = _get_translator_llm()

    # Split into chunks without breaking words aggressively
    chunks = [text[i:i+chunk_size] for i in range(0, len(text), chunk_size)]
    translated_parts = []

    for chunk in chunks:
        # Skip chunks that are already English-only
        if not contains_hindi(chunk):
            translated_parts.append(chunk)
            continue

        prompt = (
            "Translate the following Hindi text to English. "
            "Return ONLY the English translation, no explanation, no Hindi, no extra text.\n\n"
            f"{chunk}"
        )
        try:
            result = llm.invoke(prompt)
            # ChatGroq returns AIMessage with .content
            content = getattr(result, "content", str(result))
            if content and content.strip():
                translated_parts.append(content.strip())
            else:
                translated_parts.append(chunk)
        except Exception as e:
            print(f"Translation warning: {e}")
            translated_parts.append(chunk)

    return " ".join(translated_parts)

def translate_if_needed(text: str) -> str:
    """Convenience wrapper: translate only if Hindi detected."""
    if contains_hindi(text):
        return translate_hindi_to_english(text)
    return text
