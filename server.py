"""
VideoRAG Backend Server
Keeps existing RAG logic from main.py unchanged, exposed via FastAPI for Chrome Extension.
Lifecycle: Video → Process → Generate Answer → Discard temporary data
"""
import gc
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_groq import ChatGroq
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import PromptTemplate
from onnx_embeddings import BGEOnnxEmbeddings
from langchain_core.runnables import RunnableParallel, RunnablePassthrough, RunnableLambda
from langchain_core.output_parsers import StrOutputParser
from translator import translate_if_needed

load_dotenv()

app = FastAPI(title="VideoRAG API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- RAG setup (identical to main.py) ----

llm = ChatGroq(
    model="openai/gpt-oss-120b",
    temperature=0
)

splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200
)

embeddings = BGEOnnxEmbeddings()

prompt = PromptTemplate(
    template="""
            you are a helpful assistant.
            Anser ONLY from the provided transcript context.
            If the context is insufficient, just say you don't know.
            Do not use MARKDOWN.
            {context}

            question : {question}
""",
    input_variables=["context", "question"]
)

parser = StrOutputParser()

def format_docs(retrieved_docs):
    context_text = "\n\n".join(
        doc.page_content for doc in retrieved_docs
    )
    return context_text

# Cache: video_id -> {vector_store, retriever, final_chain}
video_chains = {}

def _build_rag_chain(video_id: str):
    """Internal helper to build RAG chain for a video. Keeps RAG logic identical to main.py."""
    print("Processing video...")
    print("Fetching transcript...")

    try:
        api = YouTubeTranscriptApi()
        try:
            transcript_list = api.fetch(
                video_id,
                languages=["en", "hi"]
            )
        except NoTranscriptFound:
            # Video HAS captions, just not in en/hi (e.g. only Tamil/Spanish/etc).
            # Fall back to any available caption, translating to English if possible.
            print("en/hi captions not found, trying fallback...")
            listed = api.list(video_id)
            for t in listed:
                print(f"Available: {t.language_code} ({t.language}) generated={t.is_generated} translatable={t.is_translatable}")
            try:
                fallback = listed.find_transcript(["en", "hi"])
            except Exception:
                # take first manually-created, else first auto-generated
                try:
                    fallback = listed.find_manually_created_transcript()
                except Exception:
                    fallback = next(iter(listed))
            if fallback.is_translatable:
                try:
                    fallback = fallback.translate("en")
                except Exception as e:
                    print(f"Translate-to-en failed, using original: {e}")
            transcript_list = fallback.fetch()
        transcript = " ".join(chunk.text for chunk in transcript_list)
    except TranscriptsDisabled:
        print(f"TranscriptsDisabled for {video_id}")
        raise HTTPException(status_code=404, detail="No caption available for this video")
    except Exception as e:
        print(f"Transcript fetch failed for {video_id}: {type(e).__name__}: {e}")
        err_msg = str(e).lower()
        if "transcript" in err_msg or "caption" in err_msg or "disabled" in err_msg or "not found" in err_msg or "no transcript" in err_msg or "translatable" in err_msg or "translation" in err_msg:
            raise HTTPException(status_code=404, detail="No caption available for this video")
        raise HTTPException(status_code=500, detail=f"Failed to fetch transcript: {str(e)}")

    if not transcript or not transcript.strip():
        raise HTTPException(status_code=404, detail="No caption available for this video")

    # Translator: convert Hindi transcript to English before RAG (do not alter other logic)
    transcript = translate_if_needed(transcript)

    # text splitting
    chunks = splitter.create_documents([transcript])

    # Lifecycle: Delete the uploaded video after processing (raw transcript source)
    # Keep only chunks/embeddings needed for retrieval
    del transcript_list
    del transcript
    gc.collect()

    print("getting ready..")

    vector_store = FAISS.from_documents(
        chunks,
        embeddings
    )

    # Release chunks after embeddings/FAISS index built (chunks no longer needed raw)
    del chunks
    gc.collect()

    retriever = vector_store.as_retriever(
        search_type="mmr",
        search_kwargs={"k": 4}
    )

    parallel_chain = RunnableParallel({
        "context": retriever | RunnableLambda(format_docs),
        "question": RunnablePassthrough()
    })

    final_chain = parallel_chain | prompt | llm | parser

    return vector_store, retriever, final_chain

class ProcessRequest(BaseModel):
    video_id: str

class AskRequest(BaseModel):
    video_id: str
    question: str

@app.get("/")
def health():
    return {"status": "ok", "message": "VideoRAG API running"}

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.post("/process")
def process_video(req: ProcessRequest):
    video_id = req.video_id.strip()

    if not video_id:
        raise HTTPException(status_code=400, detail="video_id is required")

    # Discard previous video's temporary data
    for old_video_id, chain_data in list(video_chains.items()):
        if old_video_id != video_id:
            video_chains.pop(old_video_id, None)

            del chain_data["vector_store"]
            del chain_data["retriever"]
            del chain_data["final_chain"]

            gc.collect()

    # Already processed
    if video_id in video_chains:
        return {
            "status": "already_processed",
            "video_id": video_id,
            "message": "Video already processed"
        }

    vector_store, retriever, final_chain = _build_rag_chain(video_id)

    video_chains[video_id] = {
        "vector_store": vector_store,
        "retriever": retriever,
        "final_chain": final_chain
    }

    return {
        "status": "processed",
        "video_id": video_id,
        "message": "Video processed successfully"
    }

@app.post("/ask")
def ask_question(req: AskRequest):
    video_id = req.video_id.strip()
    question = req.question.strip()

    if not video_id or not question:
        raise HTTPException(
            status_code=400,
            detail="video_id and question are required"
        )

    if video_id not in video_chains:
        raise HTTPException(
            status_code=404,
            detail="Video is not processed"
        )

    final_chain = video_chains[video_id]["final_chain"]

    print("-" * 30)
    print("Solution...")

    try:
        result = final_chain.invoke(question)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"LLM error: {str(e)}"
        )

    return {
        "answer": result,
        "video_id": video_id
    }



    

@app.get("/status/{video_id}")
def get_status(video_id: str):
    if video_id in video_chains:
        return {"status": "ready", "video_id": video_id}
    return {"status": "not_processed", "video_id": video_id}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
