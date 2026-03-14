package com.example.app

import com.example.models.User
import com.example.utils.Logger

data class Config(
    val host: String,
    val port: Int,
    val debug: Boolean = false
)

interface Repository<T> {
    fun findById(id: String): T?
    fun save(entity: T): T
    fun delete(id: String)
}

class UserRepository(private val config: Config) : Repository<User> {
    private val logger = Logger("UserRepository")

    override fun findById(id: String): User? {
        logger.info("Finding user: $id")
        return null
    }

    override fun save(entity: User): User {
        logger.info("Saving user: ${entity.name}")
        return entity
    }

    override fun delete(id: String) {
        logger.info("Deleting user: $id")
    }

    fun findByEmail(email: String): User? {
        return null
    }

    companion object {
        fun create(config: Config): UserRepository {
            return UserRepository(config)
        }

        fun default(): UserRepository {
            return UserRepository(Config("localhost", 5432))
        }
    }
}

object AppRegistry {
    private val services = mutableMapOf<String, Any>()

    fun register(name: String, service: Any) {
        services[name] = service
    }

    fun get(name: String): Any? {
        return services[name]
    }
}

fun initializeApp(config: Config): UserRepository {
    val repo = UserRepository.create(config)
    AppRegistry.register("userRepo", repo)
    return repo
}

val DEFAULT_CONFIG = Config("localhost", 8080)
