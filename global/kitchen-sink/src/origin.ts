import { Context } from 'effect'

class Origin extends Context.Tag('Origin')<Origin, string>() {}

export { Origin }
