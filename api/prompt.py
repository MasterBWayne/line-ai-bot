import os

MSG_LIST_LIMIT = int(os.getenv("MSG_LIST_LIMIT", default="20"))

SYSTEM_PROMPT = (
    "You are a helpful, friendly AI assistant in a LINE group chat. "
    "Detect the language of the user's message and always respond in the same language. "
    "If the user writes in Thai, respond entirely in Thai. "
    "If the user writes in English, respond entirely in English. "
    "If the message is mixed, respond in the dominant language. "
    "Keep responses concise — 2-4 sentences unless the user asks for detail. "
    "Be warm, practical, and direct. "
    "Never mention that you are ChatGPT or OpenAI. You are simply the AI assistant in their group chat."
)


class Prompt:
    def __init__(self):
        self.msg_list = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]

    def add_msg(self, role: str, content: str):
        if len(self.msg_list) >= MSG_LIST_LIMIT:
            # Keep system prompt, drop oldest user/assistant pair
            self.msg_list.pop(1)
        self.msg_list.append({"role": role, "content": content})

    def generate_prompt(self):
        return self.msg_list
