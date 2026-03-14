package com.example.app

import scala.collection.mutable
import scala.concurrent.Future

// Singleton object
object AppConfig {
  val defaultPort: Int = 8080
  var debug: Boolean = false

  def load(path: String): AppConfig = {
    new AppConfig(path)
  }
}

// Class with constructor
class AppConfig(val configPath: String) {
  val settings: mutable.Map[String, String] = mutable.Map.empty

  def get(key: String): Option[String] = settings.get(key)

  def set(key: String, value: String): Unit = {
    settings(key) = value
  }
}

// Trait definition
trait Repository[T] {
  def findById(id: Long): Option[T]
  def save(entity: T): Unit
  def delete(id: Long): Boolean
}

// Case class (value type)
case class User(id: Long, name: String, email: String)

// Class implementing trait
class UserRepository extends Repository[User] {
  private val store: mutable.Map[Long, User] = mutable.Map.empty

  override def findById(id: Long): Option[User] = store.get(id)

  override def save(entity: User): Unit = {
    store(entity.id) = entity
  }

  override def delete(id: Long): Boolean = {
    store.remove(id).isDefined
  }
}

// Type alias
type UserId = Long

// Val and var definitions
val MaxRetries: Int = 3
var currentUser: Option[User] = None

// Top-level function
def createRepository(): Repository[User] = {
  new UserRepository()
}
