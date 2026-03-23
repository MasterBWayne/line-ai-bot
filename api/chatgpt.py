import os
from openai import OpenAI
from api.prompt import Prompt

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


class ChatGPT:
    def __init__(self):
        self.prompt = Prompt()
        self.model = os.getenv("OPENAI_MODEL", default="gpt-4o-mini")
        self.temperature = float(os.getenv("OPENAI_TEMPERATURE", default="0.7"))
        self.max_tokens = int(os.getenv("OPENAI_MAX_TOKENS", default="1000"))

    def get_response(self, user_message: str) -> str:
        self.prompt.add_msg("user", user_message)
        response = client.chat.completions.create(
            model=self.model,
            messages=self.prompt.generate_prompt(),
            temperature=self.temperature,
            max_tokens=self.max_tokens,
        )
        reply = response.choices[0].message.content.strip()
        self.prompt.add_msg("assistant", reply)
        return reply
