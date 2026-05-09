FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY ./src ./src
COPY ./index.html ./
COPY ./tailwind.config.js ./
COPY ./postcss.config.js ./
COPY ./tsconfig.json ./

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
