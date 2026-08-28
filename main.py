import gc
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_groq import ChatGroq
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import PromptTemplate
from langchain_huggingface import HuggingFaceEmbeddings, ChatHuggingFace, HuggingFaceEndpoint,HuggingFacePipeline
from langchain_core.runnables import RunnableParallel, RunnablePassthrough, RunnableLambda
from langchain_core.output_parsers import StrOutputParser
from dotenv import load_dotenv
from translator import translate_if_needed

# indexing

load_dotenv()

llm = ChatGroq(
    model="openai/gpt-oss-120b",
    temperature=0
)
video_id = "Gfr50f6ZBvo"  # only id,not url

# text_spliting - kept identical
splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200
)

# Embedding Generation and storing in vectore store - kept identical
embeddings = HuggingFaceEmbeddings(
    model_name="sentence-transformers/all-MiniLM-L6-v2",
    model_kwargs={
        "backend": "onnx"
    }
)

## Retrieval - prompt kept identical
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


# question
def question():
    Question = input("Ask your question (type exit to terminate): ")
    return Question


# Building chain - kept identical
def format_docs(retrieved_docs):
    context_text = "\n\n".join(
        doc.page_content for doc in retrieved_docs
    )
    return context_text


parser = StrOutputParser()

# Lifecycle: Video → Process → Generate Answer → Discard
# Each video is processed, answer generated, then temporary data is discarded
while True:
    user_question = question()
    print("-"*30)
    print("Soution...")

    if user_question == "exit":
        print("Exiting...")
        break

    # ---- Process Phase: Video → Process ----
    try:
        api = YouTubeTranscriptApi()

        print("Processing video...")

        transcript_list = api.fetch(
            video_id,
            languages=["en", "hi"]
        )

        transcript = " ".join(chunk.text for chunk in transcript_list)

        # Translator: convert Hindi transcript to English before RAG (do not alter other logic)
        transcript = translate_if_needed(transcript)

    except TranscriptsDisabled:
        print("No caption available for this video")
        continue

    # text_spliting
    chunks = splitter.create_documents([transcript])

    # Lifecycle: Delete the uploaded video after processing (raw transcript source)
    # Keep only chunks needed for embeddings
    try:
        del transcript_list
    except NameError:
        pass
    try:
        del transcript
    except NameError:
        pass
    gc.collect()

    print("getting ready..")

    vector_store = FAISS.from_documents(
        chunks,
        embeddings
    )

    ## Retrieval
    retriever = vector_store.as_retriever(
        search_type="mmr",
        search_kwargs={"k": 4}
    )

    ## Augmentation - Building chain
    parallel_chain = RunnableParallel({
        "context": retriever | RunnableLambda(format_docs),
        "question": RunnablePassthrough()
    })

    final_chain = parallel_chain | prompt | llm | parser

    # ---- Generate Answer Phase ----
    result = final_chain.invoke(user_question)

    print(result)

    # ---- Discard Phase: Release transcript, chunks, embeddings/FAISS index, and retriever after answer ----
    # Lifecycle: Video → Process → Generate Answer → Discard
    try:
        del chunks
    except NameError:
        pass
    try:
        del vector_store
    except NameError:
        pass
    try:
        del retriever
    except NameError:
        pass
    try:
        del parallel_chain
    except NameError:
        pass
    try:
        del final_chain
    except NameError:
        pass
    gc.collect()
    # Temporary data discarded, ready for next video lifecycle
