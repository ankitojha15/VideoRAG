import os
import numpy as np
import onnxruntime as ort

from huggingface_hub import snapshot_download
from transformers import AutoTokenizer
from langchain_core.embeddings import Embeddings


MODEL_ID = "onnx-community/bge-small-en-v1.5-ONNX"
MODEL_DIR = "./models/bge-small-en-v1.5"


class BGEOnnxEmbeddings(Embeddings):

    def __init__(self):
        snapshot_download(
            repo_id=MODEL_ID,
            local_dir=MODEL_DIR
        )

        self.tokenizer = AutoTokenizer.from_pretrained(
            MODEL_DIR
        )

        model_path = os.path.join(
            MODEL_DIR,
            "onnx",
            "model_quantized.onnx"
        )

        self.session = ort.InferenceSession(
            model_path,
            providers=["CPUExecutionProvider"]
        )

    def _embed(self, texts):

        encoded = self.tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="np"
        )

        inputs = {
            "input_ids": encoded["input_ids"].astype(np.int64),
            "attention_mask": encoded["attention_mask"].astype(np.int64)
        }

        if "token_type_ids" in encoded:
            inputs["token_type_ids"] = encoded["token_type_ids"].astype(np.int64)

        outputs = self.session.run(None, inputs)

        embeddings = outputs[0][:, 0, :]

        embeddings = embeddings / np.linalg.norm(
            embeddings,
            axis=1,
            keepdims=True
        )

        return embeddings.astype(np.float32).tolist()

    def embed_documents(self, texts):
        return self._embed(texts)

    def embed_query(self, text):

        text = (
            "Represent this sentence for searching relevant passages: "
            + text
        )

        return self._embed([text])[0]